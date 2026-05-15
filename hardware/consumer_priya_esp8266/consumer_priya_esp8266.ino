// ================================================
// BGI Smart Water Grid — Consumer Priya (ESP8266)
// Valve-only node (no flow sensor installed)
// DUAL MODE (Internet/Firebase + USB Serial)
// ================================================
#include <ESP8266WiFi.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>
#include <WiFiManager.h>
#include <Ticker.h>
#include <Wire.h>
#include <SoftwareSerial.h>

// ========================= NODE LINK (UART Bridge) =========================
SoftwareSerial NodeLink(D6, D4); // RX, TX
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include "env.h"

// ========================= FIREBASE =========================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
bool firebaseConnected = false;

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
float tamperThreshold = 0.2; 
float shockThreshold = 0.5;  

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

bool emergencyChangedLocally = false;

// ========================= ALERT LOGGER =========================
void logAlert(const char* node, const char* type, const char* msg) {
  if (firebaseConnected && Firebase.ready()) {
    FirebaseJson json;
    json.add("node", node);
    json.add("type", type);
    json.add("msg", msg);
    json.set("timestamp/.sv", "timestamp");
    Firebase.RTDB.pushJSON(&fbdo, F("alertLogs"), &json);
  }
}

// ========================= EMERGENCY CONTROL =========================
void setEmergency(bool state, const char* source) {
  if (emergencyActive == state) return; 
  emergencyActive = state;
  Serial.printf("SOS EMERGENCY [%s]: %s\n", source, emergencyActive ? "ON" : "OFF");
  
  if (emergencyActive) {
    emergencyValue = 60.0; 
    lastEmergencyTick = millis();
    if (firebaseConnected && Firebase.ready()) {
      FirebaseJson log;
      log.add("nodeId", "consumer_node_8266");
      log.add("event", "SOS_ACTIVATED");
      log.add("source", source);
      log.add("type", "TIME_BASED");
      log.set("timestamp/.sv", "timestamp");
      Firebase.Firestore.createDocument(&fbdo, FIREBASE_PROJECT_ID, "", "emergencyLogs", log.raw());
    }
  }
  
  if (firebaseConnected && Firebase.ready()) {
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/emergencyActive"), emergencyActive);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyValue"), emergencyValue);
    Firebase.RTDB.setString(&fbdo, F("sensorData/consumer_node_8266/emergencySource"), source);
  }
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
  Serial.println(F("\n== Consumer Node Priya Starting (Dual Mode) =="));

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);
  currentValveState = false;

  pinMode(EMERGENCY_BUTTON_PIN, INPUT_PULLUP);
  pinMode(EMERGENCY_LED_PIN, OUTPUT);
  digitalWrite(EMERGENCY_LED_PIN, LOW);

  NodeLink.begin(9600);
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
  wm.setConfigPortalTimeout(30);
  if (!wm.autoConnect("JalBoard_Priya_AP")) {
    Serial.println(F("WiFi config timeout. Booting in offline/USB mode."));
  } else {
    Serial.println(F("WiFi Connected!"));
    config.api_key = API_KEY;
    config.database_url = DATABASE_URL;
    if (Firebase.signUp(&config, &auth, "", "")) {
      Serial.println("Sign-up Success");
      firebaseConnected = true;
    } else {
      Serial.printf("Sign-up Fail: %s\n", config.signer.signupError.message.c_str());
    }

    config.token_status_callback = tokenStatusCallback;
    Firebase.begin(&config, &auth);
    Firebase.reconnectWiFi(true);
    fbdo.setResponseSize(2048);
    fbdo.setBSSLBufferSize(2048, 1024);
  }

  Serial.printf("Setup OK | Heap: %d\n", ESP.getFreeHeap());
}

void loop() {
  static unsigned long lastWifiCheck = 0;
  static unsigned long wifiDownStartTime = 0;
  
  if (WiFi.status() != WL_CONNECTED) {
    firebaseConnected = false;
    if (wifiDownStartTime == 0) wifiDownStartTime = millis();
    if (millis() - wifiDownStartTime > 30000 && millis() - lastWifiCheck > 10000) {
      lastWifiCheck = millis();
      WiFi.reconnect();
    }
  } else {
    wifiDownStartTime = 0;
    firebaseConnected = true;
  }

  // ---- UART SERIAL COMMANDS (From Gateway) ----
  if (NodeLink.available() || Serial.available()) {
    String line = NodeLink.available() ? NodeLink.readStringUntil('\n') : Serial.readStringUntil('\n');
    line.trim();
    int colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      String targetNode = line.substring(0, colonIdx);
      String cmd = line.substring(colonIdx + 1);
      
      if (targetNode == "consumer_node_8266") {
        if (cmd == "toggleSOS") {
          setEmergency(!emergencyActive, "UART_SERIAL");
        } else if (cmd == "clearTamper") {
          tamperDetected = false;
          if (mpuInitialized) {
            sensors_event_t a, g, temp;
            mpu.getEvent(&a, &g, &temp);
            baseAccelX = a.acceleration.x; baseAccelY = a.acceleration.y; baseAccelZ = a.acceleration.z;
          }
          if (firebaseConnected && Firebase.ready()) {
             Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), true);
          }
        } else if (cmd == "resetData") {
          tamperDetected = false; emergencyActive = false; emergencyValue = 0;
        } else if (cmd == "openValve") {
          currentValveState = true;
          digitalWrite(RELAY_PIN, RELAY_ON);
          if (firebaseConnected && Firebase.ready()) Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), true);
        } else if (cmd == "closeValve") {
          currentValveState = false;
          digitalWrite(RELAY_PIN, RELAY_OFF);
          if (firebaseConnected && Firebase.ready()) Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), false);
        }
      }
    }
  }

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

  if (firebaseConnected && Firebase.ready() && (millis() - lastControlCheckMs > 1000)) {
    lastControlCheckMs = millis();

    if (Firebase.RTDB.getJSON(&fbdo, F("commands/consumer_node_8266"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("reset")) && d.success && d.boolValue) {
        tamperDetected = false; emergencyActive = false; emergencyValue = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node_8266/reset"), false);
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
        Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), true); 
        if (mpuInitialized) {
          sensors_event_t a, g, temp;
          mpu.getEvent(&a, &g, &temp);
          baseAccelX = a.acceleration.x; baseAccelY = a.acceleration.y; baseAccelZ = a.acceleration.z;
        }
      }
    }

    bool gov = true, usr = true;
    if (Firebase.RTDB.getJSON(&fbdo, F("valves/consumer_node_8266"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("gov")) && d.success) gov = d.boolValue;
      if (j.get(d, F("user")) && d.success) usr = d.boolValue;
    }

    bool newState = (gov && usr && !tamperDetected) || emergencyActive;
    if (newState != currentValveState) {
      currentValveState = newState;
      digitalWrite(RELAY_PIN, currentValveState ? RELAY_ON : RELAY_OFF);
      lastValveActionTime = millis();
    }
  }

  if (emergencyActive && (millis() - lastEmergencyTick > 1000)) {
    lastEmergencyTick = millis();
    if (emergencyValue > 0) {
      emergencyValue -= 1.0;
    } else {
      setEmergency(false, "QUOTA_EXHAUSTED");
    }
    static unsigned long lastValueReport = 0;
    if (firebaseConnected && Firebase.ready() && millis() - lastValueReport > 2000) {
      lastValueReport = millis();
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyValue"), emergencyValue);
    }
  }

  static unsigned long lastMPU = 0;
  static unsigned long movementStart = 0;
  static float jerkAccumulator = 0;
  
  if (mpuInitialized && (millis() - lastMPU > 50)) {
    lastMPU = millis();
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    float ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;
    
    if (baseAccelX == 0 && baseAccelY == 0 && baseAccelZ == 0) {
      baseAccelX = ax; baseAccelY = ay; baseAccelZ = az;
    }

    static float prevX = ax, prevY = ay, prevZ = az;
    float jerk = fabsf(ax - prevX) + fabsf(ay - prevY) + fabsf(az - prevZ);
    prevX = ax; prevY = ay; prevZ = az;
    jerkAccumulator = (jerkAccumulator * 0.9f) + jerk;

    float dotProduct = (ax * baseAccelX + ay * baseAccelY + az * baseAccelZ);
    float magCurr = sqrtf(ax*ax + ay*ay + az*az);
    float magBase = sqrtf(baseAccelX*baseAccelX + baseAccelY*baseAccelY + baseAccelZ*baseAccelZ);
    float angleCos = dotProduct / (magCurr * magBase);
    if (angleCos > 1.0f) angleCos = 1.0f;
    float tiltAngle = acosf(angleCos) * 57.2958f;

    bool isMoving = (jerkAccumulator > (tamperThreshold * 2.0f)) || (tiltAngle > 25.0f);
    
    if (isMoving) {
      if (movementStart == 0) movementStart = millis();
      unsigned long held = millis() - movementStart;
      bool buttonHeld = (digitalRead(EMERGENCY_BUTTON_PIN) == LOW);
      if (!tamperDetected && !buttonHeld && (held > 2000) && (millis() - lastValveActionTime > 8000)) {
        tamperDetected = true;
        lastTamperTime = millis();
        logAlert("Priya", "TAMPER", "Confirmed displacement/tilt detected. Valve locked.");
        if (firebaseConnected && Firebase.ready()) Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node_8266/gov"), false);
      }
    } else {
      movementStart = 0;
      if (!tamperDetected) {
        baseAccelX = baseAccelX * 0.999f + ax * 0.001f;
        baseAccelY = baseAccelY * 0.999f + ay * 0.001f;
        baseAccelZ = baseAccelZ * 0.999f + az * 0.001f;
      }
    }
  }

  static unsigned long lastSettingsSync = 0;
  if (firebaseConnected && Firebase.ready() && (millis() - lastSettingsSync > 15000 || lastSettingsSync == 0)) {
    lastSettingsSync = millis();
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/tamperSensitivity"))) {
      float ts = fbdo.floatData();
      if (ts > 0.01 && ts < 10.0) tamperThreshold = ts;
    }
  }

  // ---- USB SERIAL + FIREBASE JSON ----
  if (millis() - sendDataPrevMillis > 500) {
    sendDataPrevMillis = millis();
    
    if (firebaseConnected && Firebase.ready()) {
      Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/tamperDetected"), tamperDetected);
      Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/valveState"), currentValveState);
      Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node_8266/emergencyActive"), emergencyActive);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyValue"), emergencyValue);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/flowRate"), 0);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/totalLitres"), 0);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node_8266/emergencyLitres"), 0);
      Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/consumer_node_8266/lastSeen"));
    }

    char jsonBuf[256];
    snprintf(jsonBuf, sizeof(jsonBuf), "{\"node\":\"consumer_node_8266\",\"flowRate\":0,\"totalLitres\":0,\"valveState\":%s,\"tamperDetected\":%s,\"emergencyActive\":%s,\"emergencyValue\":%.2f,\"theftCandidate\":false,\"lastSeen\":%lu}",
      currentValveState ? "true" : "false", 
      tamperDetected ? "true" : "false", emergencyActive ? "true" : "false", 
      emergencyValue, millis());
      
    Serial.println(jsonBuf);
    NodeLink.println(jsonBuf); // Send to Ramesh (Gateway)
  }
}
