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
const float TAMPER_THRESHOLD = 0.3; // Ultra-sensitive for instant touch detection
const float SHOCK_THRESHOLD = 1.2;  // Immediate trigger on physical shock

// ========================= HARDWARE PINS =========================
#define RELAY_PIN D3
#define RELAY_ON LOW
#define RELAY_OFF HIGH
#define EMERGENCY_BUTTON_PIN D7
#define EMERGENCY_LED_PIN D5

// ========================= STATE =========================
bool  emergencyActive  = false;
bool  tamperDetected   = false;
bool  currentValveState = false;
float flowRate         = 0.0;   // Always 0 (no sensor)
float totalLitres      = 0.0;   // Always 0 (no sensor)
float emergencyLitres  = 0.0;   // Always 0 (no sensor)
float emergencyValue   = 0.0;   // Current SOS quota remaining (seconds)
unsigned long lastEmergencyTick = 0;
unsigned long lastValveActionTime = 0;

// ========================= BUTTON ISR =========================
volatile bool physicalEmergencyRequested = false;
void ICACHE_RAM_ATTR buttonISR() {
  static unsigned long lastBtn = 0;
  if (millis() - lastBtn > 500) { // Increased debounce to 500ms
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
  if (emergencyActive == state) return; // Ignore if no change
  emergencyActive = state;
  Serial.printf("SOS EMERGENCY [%s]: %s\n", source, emergencyActive ? "ON" : "OFF");
  
  if (emergencyActive) {
    emergencyValue = 60.0; // 60 seconds quota per activation
    lastEmergencyTick = millis();
  } else {
    // Log to Firestore on completion
    FirebaseJson log;
    log.add("nodeId", "consumer_node_8266");
    log.add("event", "SOS_OVERRIDE");
    log.add("source", source);
    log.add("type", "TIME_BASED");
    log.set("timestamp/.sv", "timestamp");
    Firebase.Firestore.createDocument(&fbdo, FIREBASE_PROJECT_ID, "", "emergencyLogs", log.raw());
  }
  
  Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/emergencyActive"), emergencyActive);
  Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyValue"), emergencyValue);
  Firebase.RTDB.setString(&fbdo, F("sensorData/consumer_node_8266/emergencySource"), source);
  digitalWrite(EMERGENCY_LED_PIN, emergencyActive ? HIGH : LOW);
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
  WiFi.setAutoReconnect(true); // Hardware level auto-reconnect
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
  pinMode(EMERGENCY_LED_PIN, OUTPUT);
  digitalWrite(EMERGENCY_LED_PIN, LOW);
  pinMode(RELAY_PIN, OUTPUT);
  currentValveState = true; // DEFAULT ON
  digitalWrite(RELAY_PIN, RELAY_ON);
  pinMode(EMERGENCY_BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(EMERGENCY_BUTTON_PIN), buttonISR, FALLING);

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

  // ---- 0. CONNECTION WATCHDOG ----
  static unsigned long lastWifiCheck = 0;
  static unsigned long wifiDownStartTime = 0;
  
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiDownStartTime == 0) wifiDownStartTime = millis();
    // Only attempt manual reconnect after 10s of sustained disconnect
    if (millis() - wifiDownStartTime > 10000 && millis() - lastWifiCheck > 5000) {
      lastWifiCheck = millis();
      Serial.println("WiFi sustained loss. Manual reconnect...");
      WiFi.reconnect();
    }
  } else {
    wifiDownStartTime = 0;
  }

  // ---- 0b. EMERGENCY BUTTON (2s Long Press to Start, Short Press to Stop) ----
  static unsigned long btnPressStartTime = 0;
  bool btnState = (digitalRead(EMERGENCY_BUTTON_PIN) == LOW);
  
  if (btnState) {
    if (btnPressStartTime == 0) btnPressStartTime = millis();
    if (!emergencyActive && (millis() - btnPressStartTime > 2000)) {
       setEmergency(true, "PHYSICAL_BUTTON_HOLD");
       btnPressStartTime = 0; // Prevent repeat
    }
  } else {
    if (btnPressStartTime > 0) {
       unsigned long duration = millis() - btnPressStartTime;
       // Short press to STOP if already active
       if (emergencyActive && duration < 800 && duration > 50) {
          setEmergency(false, "PHYSICAL_BUTTON_STOP");
       }
       btnPressStartTime = 0;
    }
  }

  if (physicalEmergencyRequested) {
    physicalEmergencyRequested = false;
    // Handled above in logic block
  }

  // ---- 0c. TAMPER INDICATOR (Blink SOS LED until unblocked) ----
  static unsigned long lastTamperBlink = 0;
  static bool tamperLedState = false;
  if (tamperDetected) {
    if (millis() - lastTamperBlink > 200) {
      lastTamperBlink = millis();
      tamperLedState = !tamperLedState;
      digitalWrite(EMERGENCY_LED_PIN, tamperLedState ? HIGH : LOW);
    }
  } else {
    // Normal behavior: LED shows SOS state
    digitalWrite(EMERGENCY_LED_PIN, emergencyActive ? HIGH : LOW);
  }

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
      bool newState = (gov && usr && !tamperDetected) || emergencyActive;
      if (newState != currentValveState) {
        currentValveState = newState;
        digitalWrite(RELAY_PIN, currentValveState ? RELAY_ON : RELAY_OFF);
        lastValveActionTime = millis();
        Serial.printf("Priya Relay switched: %s\n", currentValveState ? "OPEN" : "CLOSED");
      }
    }
    yield();

    // Read commands
    if (Firebase.RTDB.getJSON(&fbdo, F("commands/consumer_node_8266"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("reset")) && d.success && d.boolValue) {
        tamperDetected = false; emergencyActive = false;
        emergencyValue = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node_8266/reset"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/tamperDetected"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/emergencyActive"), false);
      }
      if (j.get(d, F("triggerEmergency")) && d.success && d.boolValue) {
        if (!emergencyActive) setEmergency(true, "WEB_DASHBOARD");
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node_8266/triggerEmergency"), false);
      }
      if (j.get(d, F("sosActive")) && d.success && !d.boolValue) {
        if (emergencyActive) setEmergency(false, "WEB_DASHBOARD");
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

  // ---- 2. EMERGENCY TIME DEDUCTION (every 1s) ----
  if (emergencyActive && (millis() - lastEmergencyTick >= 1000)) {
    lastEmergencyTick = millis();
    emergencyValue -= 1.0;
    if (emergencyValue <= 0) {
      emergencyValue = 0;
      setEmergency(false, "SYSTEM_AUTO_STOP");
    }
    // Report remaining time to Firebase every 2s
    static unsigned long lastValueReport = 0;
    if (millis() - lastValueReport > 2000) {
      lastValueReport = millis();
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyValue"), emergencyValue);
    }
  }

  // ---- 3. TAMPER DETECTION via MPU6050 (every 500ms) ----
  static unsigned long lastMPU = 0;
  static unsigned long movementStart = 0;
  static float baseMag = 0.0;
  if (mpuInitialized && (millis() - lastMPU > 500)) {
    lastMPU = millis();
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    float ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;
    float mag = sqrtf(ax * ax + ay * ay + az * az);
    if (baseMag <= 0.001f) baseMag = mag;

    float dmag = fabsf(mag - baseMag);
    bool shock = dmag > (SHOCK_THRESHOLD * 0.8f);
    bool touch = dmag > (TAMPER_THRESHOLD * 0.6f);

    if (shock || touch) {
      if (movementStart == 0) movementStart = millis();
      unsigned long held = millis() - movementStart;
      if ((shock && held > 60) || (!shock && held > 700)) {
        if (!tamperDetected && (millis() - lastValveActionTime > 4000)) {
          tamperDetected = true;
          lastTamperTime = millis();
          logAlert("Priya", "TAMPER", "Physical touch / displacement detected (MPU). Blocking valve.");
          Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), false); // BLOCK USER
        }
      }
    } else {
      movementStart = 0;
    }

    if (!tamperDetected && movementStart == 0) {
      baseMag = baseMag * 0.98f + mag * 0.02f;
      baseAccelX = baseAccelX * 0.98 + ax * 0.02;
      baseAccelY = baseAccelY * 0.98 + ay * 0.02;
      baseAccelZ = baseAccelZ * 0.98 + az * 0.02;
    }
  }

  // ---- 4. SYNC DATA (every 5s — no flow sensor, less frequent) ----
  if (millis() - sendDataPrevMillis > 5000) {
    sendDataPrevMillis = millis();
    
    if (Firebase.ready()) {
      Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/tamperDetected"), tamperDetected);
      Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/valveState"), currentValveState);
      Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/emergencyActive"), emergencyActive);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyValue"), emergencyValue);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/flowRate"), 0);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/totalLitres"), 0);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyLitres"), 0);
      Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/consumer_node_8266/lastSeen"));
      
      Serial.printf("Priya Sync OK | Valve:%s | Tamper:%s | Emg:%s\n",
        currentValveState ? "OPEN" : "CLOSED",
        tamperDetected ? "YES" : "No",
        emergencyActive ? "ACTIVE" : "Off");
    } else {
      Serial.println("Firebase not ready for Priya sync.");
    }
  }
}
