// ================================================
// BGI Smart Water Grid — Consumer Ramesh (ESP8266)
// Production-stable firmware for 24/7 operation
// ================================================
#include "env.h"
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <ESP8266WiFi.h>
#include <Firebase_ESP_Client.h>
#include <WiFiManager.h>
#include <Wire.h>
#include "addons/RTDBHelper.h"
#include "addons/TokenHelper.h"

// ========================= FIREBASE =========================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// ========================= TIMING =========================
unsigned long sendDataPrevMillis   = 0;
unsigned long sendFlowPrevMillis   = 0;
unsigned long lastControlCheckMs   = 0;

// ========================= MPU6050 =========================
Adafruit_MPU6050 mpu;
bool mpuInitialized = false;
unsigned long lastTamperTime = 0;
float baseAccelX = 0, baseAccelY = 0, baseAccelZ = 0;
float tamperThreshold = 0.2; // Configurable via Firebase (Binary Rule default)
float shockThreshold = 0.5;  // Configurable via Firebase (Binary Rule default)
unsigned long theftWarningDelayMs = 5000; // Configurable (5s delay as requested)
float minFlowThreshold = 0.001; // Configurable (Binary Rule default)

// ========================= HARDWARE PINS =========================
#define RELAY_PIN D3
#define RELAY_ON LOW
#define RELAY_OFF HIGH
#define EMERGENCY_BUTTON_PIN D7
#define FLOW_SENSOR_PIN D6
#define EMERGENCY_LED_PIN D5

// ========================= STATE =========================
bool  emergencyActive  = false;
bool  tamperDetected   = false;
bool  currentValveState = false;
float flowRate         = 0.0;
float totalLitres      = 0.0;   // Billed usage
float emergencyLitres  = 0.0;   // Total used this session
float emergencyValue   = 0.0;   // Remaining quota in litres
float emergencyQuotaLitres = 0.050; // Default: 50ml. Updated from Firebase settings.
unsigned long lastFlowCalc = 0;
unsigned long lastValveActionTime = 0;
float flowCalibration  = 98.0;

// ========================= THEFT CANDIDATE =========================
// If consumer flow remains exactly 0 for 5 continuous seconds,
// theftCandidate = true. ANY non-zero flow instantly resets to false.
bool theftCandidate = false;
unsigned long zeroFlowStartTime = 0;

// Flag to prevent sosActive=false in Firebase from overriding a physical-button SOS.
// Set true when emergency is toggled locally; cleared when Firebase sosActive syncs to true.
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
  Serial.printf("SOS EMERGENCY [%s]: %s (Quota: %.0f ml)\n", source, emergencyActive ? "ON" : "OFF", emergencyQuotaLitres * 1000);
  
  if (emergencyActive) {
    // Set quota from settings. ESP tracks litres consumed and auto-stops.
    emergencyValue = emergencyQuotaLitres; // Remaining = full quota
    emergencyLitres = 0.0;                 // Used = 0
  } else {
    // Log to Firestore on deactivation
    FirebaseJson log;
    log.add("nodeId", "consumer_node");
    log.add("event", "SOS_OVERRIDE");
    log.add("source", source);
    log.add("litresUsed", emergencyLitres);
    log.add("quotaMl", (int)(emergencyQuotaLitres * 1000));
    log.set("timestamp/.sv", "timestamp");
    Firebase.Firestore.createDocument(&fbdo, FIREBASE_PROJECT_ID, "", "emergencyLogs", log.raw());
  }

  Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/emergencyActive"), emergencyActive);
  Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/emergencyValue"), emergencyValue);
  Firebase.RTDB.setString(&fbdo, F("sensorData/consumer_node/emergencySource"), source);
  digitalWrite(EMERGENCY_LED_PIN, emergencyActive ? HIGH : LOW);
  logAlert("Ramesh", "EMERGENCY", emergencyActive ? "Emergency ENABLED" : "Emergency DISABLED");
}

void toggleEmergency(const char* source) {
  setEmergency(!emergencyActive, source);
}

// ========================= FLOW ISR =========================
volatile unsigned long pulseCount = 0;
void ICACHE_RAM_ATTR flowPulseISR() {
  pulseCount++;
}

// ========================= SETUP =========================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n== Consumer Node Ramesh Starting =="));

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);
  currentValveState = false;

  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR, RISING);

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
  if (!wm.autoConnect("JalBoard_Ramesh_AP")) {
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

  // Data Recovery
  if (Firebase.ready()) {
    if (Firebase.RTDB.getFloat(&fbdo, F("sensorData/consumer_node/totalLitres"))) {
      totalLitres = fbdo.floatData();
    }
  }

  Serial.printf("Setup OK | Heap: %d\n", ESP.getFreeHeap());
  lastFlowCalc = millis();
}

void loop() {
  // ---- 0. CONNECTION WATCHDOG ----
  static unsigned long lastWifiCheck = 0;
  static unsigned long wifiDownStartTime = 0;
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiDownStartTime == 0) wifiDownStartTime = millis();
    if (millis() - wifiDownStartTime > 10000 && millis() - lastWifiCheck > 5000) {
      lastWifiCheck = millis();
      WiFi.reconnect();
    }
  } else {
    wifiDownStartTime = 0;
  }

  // ---- 0b. EMERGENCY BUTTON (Long Press to Start, Short Press to Stop) ----
  static unsigned long btnPressStartTime = 0;
  bool btnState = (digitalRead(EMERGENCY_BUTTON_PIN) == LOW);
  if (btnState) {
    if (btnPressStartTime == 0) btnPressStartTime = millis();
    if (!emergencyActive && (millis() - btnPressStartTime > 2000)) {
       setEmergency(true, "PHYSICAL_BUTTON_HOLD");
       emergencyChangedLocally = true;
       btnPressStartTime = 0;
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

  // ---- 1. CONTROL SYNC (every 1s) ----
  if (Firebase.ready() && (millis() - lastControlCheckMs > 1000)) {
    lastControlCheckMs = millis();
    if (Firebase.RTDB.getJSON(&fbdo, F("commands/consumer_node"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("reset")) && d.success && d.boolValue) {
        totalLitres = 0; tamperDetected = false; emergencyActive = false;
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node/reset"), false);
      }
      if (j.get(d, F("triggerEmergency")) && d.success && d.boolValue) {
        if (!emergencyActive) setEmergency(true, "WEB_DASHBOARD");
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node/triggerEmergency"), false);
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
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node/clearTamper"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/tamperDetected"), false);
        Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node/gov"), true);
        if (mpuInitialized) {
          sensors_event_t a, g, temp;
          mpu.getEvent(&a, &g, &temp);
          baseAccelX = a.acceleration.x; baseAccelY = a.acceleration.y; baseAccelZ = a.acceleration.z;
        }
      }
    }

    if (Firebase.RTDB.getJSON(&fbdo, F("valves/consumer_node"))) {
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
        Serial.printf("Relay switched: %s\n", currentValveState ? "OPEN" : "CLOSED");
      }
    }
  }

  // ---- 2. FLOW CALCULATION (every 1s) ----
  if (millis() - lastFlowCalc >= 1000) {
    unsigned long elapsed = millis() - lastFlowCalc;
    noInterrupts();
    unsigned long pc = pulseCount;
    pulseCount = 0;
    interrupts();

    float sec = elapsed / 1000.0;
    if (sec > 0) {
      float hz = pc / sec;
      float raw = hz / flowCalibration;
      if (pc > 0) {
        flowRate = flowRate * 0.4 + raw * 0.6;
      } else {
        flowRate = 0.0;
      }
    } else {
      flowRate = 0.0;
    }

    if (flowRate > 0 && flowRate < minFlowThreshold) {
      flowRate = 0.0;
    }

    float litres = (float)pc / (flowCalibration * 60.0); 
    if (litres > 0) {
      if (currentValveState && !emergencyActive) {
        totalLitres += litres;
      }
      if (emergencyActive) {
        emergencyLitres += litres;
        emergencyValue = emergencyQuotaLitres - emergencyLitres;
        if (emergencyValue < 0) emergencyValue = 0;
        if (emergencyLitres >= emergencyQuotaLitres) {
          setEmergency(false, "QUOTA_EXHAUSTED");
        }
      }
    }

    // THEFT CANDIDATE
    if (flowRate > 0) {
      theftCandidate = false;
      zeroFlowStartTime = 0;
    } else {
      if (zeroFlowStartTime == 0) {
        zeroFlowStartTime = millis();
      } else if (!theftCandidate && (millis() - zeroFlowStartTime >= theftWarningDelayMs)) {
        theftCandidate = true;
      }
    }

    // TAMPER
    bool flowTamper = false;
    if (!currentValveState && flowRate > 0.3) flowTamper = true;
    if (flowTamper && !tamperDetected && (millis() - lastValveActionTime > 8000)) {
      tamperDetected = true;
      logAlert("Ramesh", "TAMPER", "High flow detected while valve CLOSED! Bypass suspected.");
      Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node/gov"), false);
    }

    lastFlowCalc = millis();
    yield();
  }

  // ---- 3. MPU TAMPER (every 50ms) ----
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
    bool shock = dmag > (shockThreshold * 0.8f);
    bool touch = dmag > (tamperThreshold * 0.6f);

    if (shock || touch) {
      if (movementStart == 0) movementStart = millis();
      unsigned long held = millis() - movementStart;
      if ((shock && held > 60) || (!shock && held > 700)) {
        bool buttonHeld = (digitalRead(EMERGENCY_BUTTON_PIN) == LOW);
        if (!tamperDetected && !buttonHeld && (millis() - lastValveActionTime > 8000)) {
          tamperDetected = true;
          logAlert("Ramesh", "TAMPER", "Physical touch / displacement detected (MPU). Blocking valve.");
          Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node/gov"), false);
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

  // ---- 4. SETTINGS SYNC (every 15s) ----
  static unsigned long lastSettingsSync = 0;
  if (Firebase.ready() && (millis() - lastSettingsSync > 15000 || lastSettingsSync == 0)) {
    lastSettingsSync = millis();
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/consumerCalibration"))) {
      float v = fbdo.floatData();
      if (v > 10.0 && v < 1000.0) flowCalibration = v;
    }
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/emergencyQuotaMl"))) {
      float ml = fbdo.floatData();
      if (ml > 0 && ml < 100000) emergencyQuotaLitres = ml / 1000.0;
    }
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/tamperThreshold"))) {
      float v = fbdo.floatData();
      if (v > 0.05 && v < 5.0) tamperThreshold = v;
    }
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/shockThreshold"))) {
      float v = fbdo.floatData();
      if (v > 0.05 && v < 5.0) shockThreshold = v;
    }
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/minFlowThreshold"))) {
      float v = fbdo.floatData();
      if (v >= 0.0 && v < 10.0) minFlowThreshold = v;
    }
  }

  // ---- 5. REALTIME DATA (every 2s) ----
  static unsigned long lastRealtimeReport = 0;
  if (Firebase.ready() && (millis() - lastRealtimeReport > 2000)) {
    lastRealtimeReport = millis();
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/flowRate"), flowRate);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/totalLitres"), totalLitres);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/emergencyLitres"), emergencyLitres);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/emergencyValue"), emergencyValue);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/tamperDetected"), tamperDetected);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/theftCandidate"), theftCandidate);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/emergencyActive"), emergencyActive);
    Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/consumer_node/lastSeen"));
  }

  // ---- 6. HEARTBEAT (every 5s) ----
  static unsigned long lastHeartbeat = 0;
  if (Firebase.ready() && (millis() - lastHeartbeat > 5000 || lastHeartbeat == 0)) {
    lastHeartbeat = millis();
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/valveState"), currentValveState);
    Serial.printf("Flow:%.3f | Bill:%.2f | Emg:%.2f | Tamper:%s | Valve:%s\n",
      flowRate, totalLitres, emergencyLitres, tamperDetected ? "YES" : "No", currentValveState ? "OPEN" : "CLOSED");
  }
}
