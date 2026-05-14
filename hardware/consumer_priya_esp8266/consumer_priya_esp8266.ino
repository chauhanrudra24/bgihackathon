// ================================================
// BGI Smart Water Grid — Consumer Priya (ESP8266)
// Valve-only node (no flow sensor installed)
// Production-stable firmware for 24/7 operation
// ================================================
#include <ESP8266WiFi.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>
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
unsigned long sendDataPrevMillis = 0;
unsigned long lastControlCheckMs = 0;
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
float tamperThreshold = 0.2; // Configurable via Firebase (Binary Rule default)
float shockThreshold = 0.5;  // Configurable via Firebase (Binary Rule default)

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

// Flag to prevent sosActive=false in Firebase from overriding a physical-button SOS.
bool emergencyChangedLocally = false;

// ========================= BUTTON =========================
// NOTE: We use POLLING only for the emergency button. ISR-based button
// detection conflicts with the polling hold-duration logic and causes
// "turn on then immediately off" behavior.

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
    // Log to Firestore on activation
    FirebaseJson log;
    log.add("nodeId", "consumer_node_8266");
    log.add("event", "SOS_ACTIVATED");
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
  delay(1000);
  Serial.println(F("\n== Consumer Node Priya Starting =="));

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);
  currentValveState = false;

  pinMode(EMERGENCY_BUTTON_PIN, INPUT_PULLUP);
  pinMode(EMERGENCY_LED_PIN, OUTPUT);
  digitalWrite(EMERGENCY_LED_PIN, LOW);

  // MPU6050
  Wire.begin(D2, D1);
  if (!mpu.begin()) {
    Serial.println(F("MPU6050 not found!"));
  } else {
    Serial.println(F("MPU6050 OK"));
    mpuInitialized = true;
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    baseAccelX = a.acceleration.x;
    baseAccelY = a.acceleration.y;
    baseAccelZ = a.acceleration.z;
  }

  WiFiManager wm;
  wm.setAPCallback(configModeCallback);
  if (!wm.autoConnect("JalBoard_Priya_AP")) {
    delay(3000);
    ESP.restart();
  }

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Sign-up Success");
  } else {
    Serial.printf("Sign-up Fail: %s\n", config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  fbdo.setResponseSize(2048);
  fbdo.setBSSLBufferSize(2048, 1024);

  Serial.printf("Setup OK | Heap: %d\n", ESP.getFreeHeap());
}

void loop() {
  // ---- 0. CONNECTION WATCHDOG ----
  static unsigned long lastWifiCheck = 0;
  static unsigned long wifiDownStartTime = 0;
  
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiDownStartTime == 0) wifiDownStartTime = millis();
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
       emergencyChangedLocally = true;
       btnPressStartTime = 0; // Prevent repeat
    }
  } else {
    if (btnPressStartTime > 0) {
       unsigned long duration = millis() - btnPressStartTime;
       if (emergencyActive && duration < 800 && duration > 50) {
          setEmergency(false, "PHYSICAL_BUTTON_STOP");
          emergencyChangedLocally = true;
       }
       btnPressStartTime = 0;
    }
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
    digitalWrite(EMERGENCY_LED_PIN, emergencyActive ? HIGH : LOW);
  }

  // ---- 1. CONTROL SYNC: Valves + Commands (every 1s) ----
  if (Firebase.ready() && (millis() - lastControlCheckMs > 1000)) {
    lastControlCheckMs = millis();
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
        emergencyChangedLocally = false;
      }
      if (j.get(d, F("sosActive")) && d.success) {
        if (d.boolValue) {
          emergencyChangedLocally = false;
        } else if (!d.boolValue && emergencyActive && !emergencyChangedLocally) {
          setEmergency(false, "WEB_DASHBOARD");
        }
      }
      if (j.get(d, F("clearTamper")) && d.success && d.boolValue) {
        tamperDetected = false;
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node_8266/clearTamper"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/tamperDetected"), false);
        Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), true); // UNBLOCK
        if (mpuInitialized) {
          sensors_event_t a, g, temp;
          mpu.getEvent(&a, &g, &temp);
          baseAccelX = a.acceleration.x; baseAccelY = a.acceleration.y; baseAccelZ = a.acceleration.z;
        }
      }
    }
    yield();
  }

  // ---- 2. EMERGENCY TIMER (every 1s) ----
  if (emergencyActive && (millis() - lastEmergencyTick > 1000)) {
    lastEmergencyTick = millis();
    if (emergencyValue > 0) {
      emergencyValue -= 1.0;
    } else {
      setEmergency(false, "QUOTA_EXHAUSTED");
    }
    static unsigned long lastValueReport = 0;
    if (millis() - lastValueReport > 2000) {
      lastValueReport = millis();
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyValue"), emergencyValue);
    }
  }

  // ---- 3. TAMPER DETECTION via MPU6050 (every 50ms) ----
  static unsigned long lastMPU = 0;
  static unsigned long movementStart = 0;
  static float baseMag = 0.0;
  if (mpuInitialized && (millis() - lastMPU > 50)) {
    lastMPU = millis();
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    float ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;
    float mag = sqrtf(ax * ax + ay * ay + az * az);
    if (baseMag <= 0.001f) baseMag = mag;
    float dmag = fabsf(mag - baseMag);
    bool shock = dmag > shockThreshold;
    bool touch = dmag > tamperThreshold;

    if (shock || touch) {
      bool buttonHeld = (digitalRead(EMERGENCY_BUTTON_PIN) == LOW);
      if (!tamperDetected && !buttonHeld && (millis() - lastValveActionTime > 8000)) {
        tamperDetected = true;
        lastTamperTime = millis();
        logAlert("Priya", "TAMPER", "Physical touch / displacement detected (MPU). Blocking valve.");
        Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), false); // BLOCK USER
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

  // ---- 3.5. SETTINGS SYNC (every 15s) ----
  static unsigned long lastSettingsSync = 0;
  if (Firebase.ready() && (millis() - lastSettingsSync > 15000 || lastSettingsSync == 0)) {
    lastSettingsSync = millis();
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/tamperSensitivity"))) {
      float ts = fbdo.floatData();
      if (ts > 0.01 && ts < 10.0) tamperThreshold = ts;
    }
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/shockSensitivity"))) {
      float ss = fbdo.floatData();
      if (ss > 0.05 && ss < 20.0) shockThreshold = ss;
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
    }
  }
}
