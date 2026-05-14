// ================================================
// BGI Smart Water Grid — Consumer Ramesh (ESP8266)
// Production-stable firmware for 24/7 operation
// ================================================
#include <ESP8266WiFi.h>
#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>
#include <WiFiManager.h>
#include "env.h"

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
const float TAMPER_THRESHOLD = 0.2; // Max sensitivity for instant vibration detection
const float SHOCK_THRESHOLD = 0.8;  // Instant trigger on physical touch

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
float emergencyValue   = 0.0;   // Current quota
unsigned long lastFlowCalc = 0;
unsigned long lastValveActionTime = 0;
float flowCalibration  = 98.0; 

// ========================= BUTTON ISR =========================
volatile bool physicalEmergencyRequested = false;
void ICACHE_RAM_ATTR buttonISR() {
  static unsigned long lastBtn = 0;
  if (millis() - lastBtn > 500) { // Increased debounce to 500ms
    physicalEmergencyRequested = true;
    lastBtn = millis();
  }
}

volatile unsigned long pulseCount = 0;
void ICACHE_RAM_ATTR flowPulseISR() {
  pulseCount++;
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
    // Unlimited SOS mode (no quota). ESP tracks litres consumed during SOS.
    emergencyValue = 0.0;
    emergencyLitres = 0.0;
  } else {
    // Log to Firestore on deactivation
    FirebaseJson log;
    log.add("nodeId", "consumer_node");
    log.add("event", "SOS_OVERRIDE");
    log.add("source", source);
    log.add("duration", millis() / 1000); // Simple uptime-based duration for context
    log.set("timestamp/.sv", "timestamp");
    Firebase.Firestore.createDocument(&fbdo, FIREBASE_PROJECT_ID, "", "emergencyLogs", log.raw());
  }

  Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/emergencyActive"), emergencyActive);
  // For UI: expose emergencyValue as "SOS litres used" (since we removed quota)
  Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/emergencyValue"), emergencyLitres);
  Firebase.RTDB.setString(&fbdo, F("sensorData/consumer_node/emergencySource"), source);
  digitalWrite(EMERGENCY_LED_PIN, emergencyActive ? HIGH : LOW);
  logAlert("Ramesh", "EMERGENCY", emergencyActive ? "Emergency ENABLED" : "Emergency DISABLED");
}

void toggleEmergency(const char* source) {
  setEmergency(!emergencyActive, source);
}

// ========================= SETUP =========================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n== Ramesh Consumer Node Starting =="));

  WiFi.mode(WIFI_STA);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFiManager wm;
  WiFi.setAutoReconnect(true); // Hardware level auto-reconnect
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(EMERGENCY_BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(LED_BUILTIN, HIGH);

  if (!wm.autoConnect("Consumer_Ramesh_AP")) {
    delay(3000);
    ESP.restart();
  }
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

  // ---- Data Recovery ----
  if (Firebase.ready()) {
    if (Firebase.RTDB.getFloat(&fbdo, F("sensorData/consumer_node/totalLitres"))) {
      totalLitres = fbdo.floatData();
      Serial.printf("Recovered Total: %.2f L\n", totalLitres);
    }
  }

  // Hardware init
  pinMode(EMERGENCY_LED_PIN, OUTPUT);
  digitalWrite(EMERGENCY_LED_PIN, LOW);
  pinMode(RELAY_PIN, OUTPUT);
  currentValveState = true; // DEFAULT ON
  digitalWrite(RELAY_PIN, RELAY_ON);
  
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR, FALLING);
  pinMode(EMERGENCY_BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(EMERGENCY_BUTTON_PIN), buttonISR, FALLING);
  lastFlowCalc = millis();
  
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
    // ISR now only sets a flag; we handle logic here for stability
  }

  // ---- 0a. HIGH-PRIORITY TAMPER CHECK (Instant & Constant) ----
  if (mpuInitialized) {
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    float ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;
    float deltaX = abs(ax - baseAccelX);
    float deltaY = abs(ay - baseAccelY);
    float deltaZ = abs(az - baseAccelZ);

    if (!tamperDetected) {
      if (deltaX > TAMPER_THRESHOLD || deltaY > TAMPER_THRESHOLD || deltaZ > TAMPER_THRESHOLD) {
        tamperDetected = true;
        Serial.println(F("!! INSTANT TAMPER DETECTED !!"));
        // Immediate Reporting
        Firebase.RTDB.setBoolAsync(&fbdo, F("sensorData/consumer_node/tamperDetected"), true);
        logAlert("Ramesh", "TAMPER", "Instant physical interference detected! Supply blocked.");
      }
    }
  }

  // ---- 0b. TAMPER INDICATOR (Blink SOS LED until unblocked) ----
  static unsigned long lastTamperBlink = 0;
  static bool tamperLedState = false;
  if (tamperDetected) {
    if (millis() - lastTamperBlink > 150) { // Faster blink for alert
      lastTamperBlink = millis();
      tamperLedState = !tamperLedState;
      digitalWrite(EMERGENCY_LED_PIN, tamperLedState ? HIGH : LOW);
    }
  } else {
    // Normal behavior: LED shows SOS state
    digitalWrite(EMERGENCY_LED_PIN, emergencyActive ? HIGH : LOW);
  }

  // ---- 0c. EMERGENCY BUTTON (2s Long Press to Start, Short Press to Stop) ----

  // ---- 1. CONTROL SYNC: Valves + Commands (every 1s) ----
  if (Firebase.ready() && (millis() - lastControlCheckMs > 1000)) {
    lastControlCheckMs = millis();

    // Read valve state
    if (Firebase.RTDB.getJSON(&fbdo, F("valves/consumer_node"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      bool gov = true, usr = true;
      if (j.get(d, F("gov")) && d.success) gov = d.boolValue;
      if (j.get(d, F("user")) && d.success) usr = d.boolValue;
      // Tamper locks valve; Emergency overrides everything
      bool newState = (gov && usr && !tamperDetected) || emergencyActive;
      if (newState != currentValveState) {
        currentValveState = newState;
        digitalWrite(RELAY_PIN, currentValveState ? RELAY_ON : RELAY_OFF);
        lastValveActionTime = millis();
        Serial.printf("Relay switched: %s\n", currentValveState ? "OPEN" : "CLOSED");
      }
    }
    yield();

    // Read commands
    if (Firebase.RTDB.getJSON(&fbdo, F("commands/consumer_node"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("reset")) && d.success && d.boolValue) {
        totalLitres = 0; flowRate = 0; pulseCount = 0;
        tamperDetected = false; emergencyActive = false;
        emergencyLitres = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node/reset"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/tamperDetected"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/emergencyActive"), false);
      }
      if (j.get(d, F("triggerEmergency")) && d.success && d.boolValue) {
        if (!emergencyActive) setEmergency(true, "WEB_DASHBOARD");
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node/triggerEmergency"), false);
      }
      if (j.get(d, F("sosActive")) && d.success && !d.boolValue) {
        if (emergencyActive) setEmergency(false, "WEB_DASHBOARD");
      }
      // Allow admin to clear tamper remotely and unblock
      if (j.get(d, F("clearTamper")) && d.success && d.boolValue) {
        tamperDetected = false;
        lastTamperTime = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node/clearTamper"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/tamperDetected"), false);
        Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node/gov"), true); // UNBLOCK
        // Re-calibrate MPU baseline after admin clears
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
      float raw = hz / flowCalibration; // L/min
      // Sticky Filter: Slower decay to prevent flickering to 0
      if (pc > 0) {
        flowRate = flowRate * 0.4 + raw * 0.6;
      } else {
        flowRate = flowRate * 0.8; // Slow decay instead of instant 0
        if (flowRate < 0.02) flowRate = 0;
      }
    } else {
      flowRate = flowRate * 0.8;
      if (flowRate < 0.02) flowRate = 0;
    }

    float litres = (float)pc / (flowCalibration * 60.0); 
    if (litres > 0) {
      if (currentValveState && !emergencyActive) {
        totalLitres += litres;
      }
      if (emergencyActive) {
        emergencyLitres += litres;
        // No quota: keep emergencyActive until user/admin stops it.
        emergencyValue = emergencyLitres;
      }
    }

    // (Redundant check removed, handled at top of loop for instant response)
    lastFlowCalc = millis();
    yield();
  }

  // ---- 3. SETTINGS SYNC (every 15s) ----
  static unsigned long lastSettingsSync = 0;
  if (Firebase.ready() && (millis() - lastSettingsSync > 15000 || lastSettingsSync == 0)) {
    lastSettingsSync = millis();
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/consumerCalibration"))) {
      float v = fbdo.floatData();
      if (v > 10.0 && v < 1000.0) flowCalibration = v;
    }
  }

  // ---- 4. REALTIME DATA (every 1s) ----
  static unsigned long lastRealtimeReport = 0;
  if (Firebase.ready() && (millis() - lastRealtimeReport > 1000)) {
    lastRealtimeReport = millis();
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/flowRate"), flowRate);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/totalLitres"), totalLitres);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/emergencyLitres"), emergencyLitres);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/tamperDetected"), tamperDetected);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/emergencyActive"), emergencyActive);
    Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/consumer_node/lastSeen"));
  }

  // ---- 5. HEARTBEAT (every 5s) ----
  static unsigned long lastHeartbeat = 0;
  if (Firebase.ready() && (millis() - lastHeartbeat > 5000 || lastHeartbeat == 0)) {
    lastHeartbeat = millis();
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/valveState"), currentValveState);
    Serial.printf("Flow:%.2f | Bill:%.2f | Emg:%.2f | Tamper:%s | Valve:%s | Heap:%d\n",
      flowRate, totalLitres, emergencyLitres,
      tamperDetected ? "YES" : "No",
      currentValveState ? "OPEN" : "CLOSED",
      ESP.getFreeHeap());
  }
}
