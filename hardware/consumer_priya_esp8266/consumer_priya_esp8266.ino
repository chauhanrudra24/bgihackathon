// ================================================
// BGI Smart Water Grid — Consumer Priya (ESP8266)
// Valve-only node (no flow sensor installed)
// Production-stable firmware for 24/7 operation
// ================================================
#include <ESP8266WiFi.h>
#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"
#include <WiFiManager.h>
#include <Ticker.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include "env.h"

// ========================= FIREBASE =========================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// ========================= TIMING =========================
unsigned long sendDataPrevMillis  = 0;
unsigned long lastControlCheckMs  = 0;
Ticker blinker;

void blink() { digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); }
void configModeCallback(WiFiManager *wm) {
  Serial.println(F("AP Config Mode"));
  blinker.attach(0.2, blink);
}

// ========================= MPU6050 =========================
Adafruit_MPU6050 mpu;
bool mpuInitialized = false;
unsigned long lastTamperTime = 0;
float baseAccelX, baseAccelY, baseAccelZ;

// ========================= HARDWARE PINS =========================
#define RELAY_PIN D3
#define RELAY_ON LOW
#define RELAY_OFF HIGH
#define EMERGENCY_BUTTON_PIN D7

// ========================= STATE =========================
bool  emergencyActive  = false;
bool  tamperDetected   = false;
bool  currentValveState = false;
float flowRate         = 0.0;   // Always 0 (no sensor)
float totalLitres      = 0.0;   // Always 0 (no sensor)
float emergencyLitres  = 0.0;   // Always 0 (no sensor)
int   emergencySeconds = 0;
unsigned long lastEmergencyDec = 0;

// ========================= BUTTON ISR =========================
volatile bool physicalEmergencyRequested = false;
void ICACHE_RAM_ATTR buttonISR() {
  static unsigned long lastBtn = 0;
  if (millis() - lastBtn > 300) {
    physicalEmergencyRequested = true;
    lastBtn = millis();
  }
}

// ========================= ALERT LOGGER =========================
void logAlert(const char* node, const char* type, const char* msg) {
  FirebaseJson json;
  json.add("node", node);
  json.add("type", type);
  json.add("msg", msg);
  json.set("timestamp/.sv", "timestamp");
  Firebase.RTDB.pushJSON(&fbdo, F("alertLogs"), &json);
}

// ========================= EMERGENCY CONTROL =========================
void setEmergency(bool state, const char* source) {
  emergencyActive = state;
  Serial.printf("SOS EMERGENCY [%s]: %s\n", source, emergencyActive ? "ON" : "OFF");
  if (emergencyActive) {
    emergencySeconds = 60;
    lastEmergencyDec = millis();
  } else {
    emergencySeconds = 0;
  }
  Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/emergencyActive"), emergencyActive);
  Firebase.RTDB.setString(&fbdo, F("sensorData/consumer_node_8266/emergencySource"), source);
  logAlert("Priya", "EMERGENCY", emergencyActive ? "Emergency ENABLED" : "Emergency DISABLED");
}

void toggleEmergency(const char* source) {
  setEmergency(!emergencyActive, source);
}

// ========================= SETUP =========================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n== Priya Consumer Node (Valve Only) Starting =="));

  WiFi.mode(WIFI_STA);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFiManager wm;
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(EMERGENCY_BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(LED_BUILTIN, HIGH);
  wm.setAPCallback(configModeCallback);

  if (!wm.autoConnect("Consumer_Priya_AP")) {
    delay(3000);
    ESP.restart();
  }
  blinker.detach();
  digitalWrite(LED_BUILTIN, LOW);

  // Firebase init
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  Firebase.signUp(&config, &auth, "", "");
  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  fbdo.setResponseSize(1024);
  fbdo.setBSSLBufferSize(2048, 1024); // Increased for SSL stability

  // Hardware init
  pinMode(RELAY_PIN, OUTPUT);
  currentValveState = true; // DEFAULT ON
  digitalWrite(RELAY_PIN, RELAY_ON);
  attachInterrupt(digitalPinToInterrupt(EMERGENCY_BUTTON_PIN), buttonISR, FALLING);
  ESP.wdtEnable(WDTO_8S); // Enable hardware watchdog

  // MPU6050
  Wire.begin(D2, D1);
  if (mpu.begin()) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    mpuInitialized = true;
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    baseAccelX = a.acceleration.x;
    baseAccelY = a.acceleration.y;
    baseAccelZ = a.acceleration.z;
    Serial.println(F("MPU6050 OK"));
  } else {
    mpuInitialized = false;
    Serial.println(F("MPU6050 FAIL"));
  }
  Serial.printf("Setup OK | Heap: %d\n", ESP.getFreeHeap());
}

// ========================= MAIN LOOP =========================
void loop() {

  // ---- 0. EMERGENCY BUTTON (ISR-driven, instant) ----
  if (physicalEmergencyRequested) {
    physicalEmergencyRequested = false;
    toggleEmergency("PHYSICAL_BUTTON");
  }
  ESP.wdtFeed(); // Kick dog

  // ---- 1. CONTROL SYNC: Valves + Commands (every 1s) ----
  if (Firebase.ready() && (millis() - lastControlCheckMs > 1000)) {
    lastControlCheckMs = millis();

    // Read valve state
    if (Firebase.RTDB.getJSON(&fbdo, F("valves/consumer_node_8266"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      bool gov = true, usr = true;
      if (j.get(d, F("gov")) && d.success) gov = d.boolValue;
      if (j.get(d, F("user")) && d.success) usr = d.boolValue;
      currentValveState = (gov && usr && !tamperDetected) || emergencyActive;
      digitalWrite(RELAY_PIN, currentValveState ? RELAY_ON : RELAY_OFF);
    }
    yield();

    // Read commands
    if (Firebase.RTDB.getJSON(&fbdo, F("commands/consumer_node_8266"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("reset")) && d.success && d.boolValue) {
        tamperDetected = false; emergencyActive = false;
        emergencySeconds = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node_8266/reset"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/tamperDetected"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/emergencyActive"), false);
      }
      if (j.get(d, F("sosActive")) && d.success) {
        setEmergency(d.boolValue, "WEB_DASHBOARD");
      }
      if (j.get(d, F("triggerEmergency")) && d.success && d.boolValue) {
        toggleEmergency("WEB_DASHBOARD");
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node_8266/triggerEmergency"), false);
      }
      if (j.get(d, F("clearTamper")) && d.success && d.boolValue) {
        tamperDetected = false;
        lastTamperTime = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node_8266/clearTamper"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/tamperDetected"), false);
        Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), true); // UNBLOCK
        if (mpuInitialized) {
          sensors_event_t a, g, temp;
          mpu.getEvent(&a, &g, &temp);
          baseAccelX = a.acceleration.x;
          baseAccelY = a.acceleration.y;
          baseAccelZ = a.acceleration.z;
        }
      }
    }
  }

  // ---- 2. EMERGENCY TIMER (countdown) ----
  if (emergencyActive && (millis() - lastEmergencyDec >= 1000)) {
    lastEmergencyDec = millis();
    emergencySeconds--;
    if (emergencySeconds <= 0) {
      emergencySeconds = 0;
      emergencyActive = false;
      Serial.println(F("Emergency timer finished."));
    }
  }

  // ---- 3. TAMPER DETECTION via MPU6050 (every 500ms) ----
  static unsigned long lastMPU = 0;
  static unsigned long movementStart = 0;
  if (mpuInitialized && (millis() - lastMPU > 500)) {
    lastMPU = millis();
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    float dx = abs(a.acceleration.x - baseAccelX);
    float dy = abs(a.acceleration.y - baseAccelY);
    float dz = abs(a.acceleration.z - baseAccelZ);
    // Threshold increased to 3.0 + 1.5s persistence
    if (dx > 3.0 || dy > 3.0 || dz > 3.0) {
      if (movementStart == 0) movementStart = millis();
      if (millis() - movementStart > 1500) {
        if (!tamperDetected) {
          tamperDetected = true;
          lastTamperTime = millis();
          logAlert("Priya", "TAMPER", "Persistent motion detected! Valve LOCKED.");
          Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), false); // BLOCK USER
        }
      }
    } else {
      movementStart = 0;
    }
    if (!tamperDetected) {
      baseAccelX = baseAccelX * 0.95 + a.acceleration.x * 0.05;
      baseAccelY = baseAccelY * 0.95 + a.acceleration.y * 0.05;
      baseAccelZ = baseAccelZ * 0.95 + a.acceleration.z * 0.05;
    }
  }

  // ---- 4. SYNC DATA (every 5s — no flow sensor, less frequent) ----
  if (Firebase.ready() && (millis() - sendDataPrevMillis > 5000)) {
    sendDataPrevMillis = millis();
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/tamperDetected"), tamperDetected);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/valveState"), currentValveState);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/emergencyActive"), emergencyActive);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyValue"), emergencySeconds);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/flowRate"), 0);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/totalLitres"), 0);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyLitres"), 0);
    Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/consumer_node_8266/lastSeen"));
    Serial.printf("Valve:%s | Tamper:%s | Emg:%s | Heap:%d\n",
      currentValveState ? "OPEN" : "CLOSED",
      tamperDetected ? "YES" : "No",
      emergencyActive ? "ACTIVE" : "Off",
      ESP.getFreeHeap());
  }
}
