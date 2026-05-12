#include <ESP8266WiFi.h>
#include <Firebase_ESP_Client.h>

// Provide the token generation process info.
#include "addons/TokenHelper.h"
// Provide the RTDB payload printing info and other helper functions.
#include "addons/RTDBHelper.h"

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>
// =========================
// NETWORK & FIREBASE CONFIG
// =========================
#include "env.h"

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

unsigned long sendDataPrevMillis = 0;
unsigned long sendFlowPrevMillis = 0;
unsigned long lastValveCheckMillis = 0;

Adafruit_MPU6050 mpu;
bool mpuInitialized = false;
unsigned long lastTamperTime = 0;
float baseAccelX, baseAccelY, baseAccelZ;

// (Config mode removed)

// =========================
// VALVE PIN
// =========================
#define RELAY_PIN D3 // Relay moved to D3 (GPIO0) to free D1/D2 for I2C
#define RELAY_ON LOW
#define RELAY_OFF HIGH

// =========================
// EMERGENCY BUTTON
// =========================
#define EMERGENCY_BUTTON_PIN D7
bool emergencyActive = false;
float emergencyValueRemaining = 0.0;

// =========================
// FLOW SENSOR (1/8 inch)
// =========================
#define FLOW_SENSOR_PIN D6

// Calibrated for 6mm Inner Diameter pipe (Standard for YF-S401 / small G1/8)
#define PULSES_PER_LITRE 5880.0
#define FLOW_CALIBRATION 98.0 // F = 98 * Q (L/min) -> 5880 pulses/L

volatile unsigned long pulseCount = 0;
float flowRate = 0.0;    // L/min (Smoothed)
float totalLitres = 0.0; // Total litres since boot
unsigned long lastFlowCalc = 0;
float flowCalibration = 98.0; // Default for small G1/8

// Tamper detection - if valve is CLOSED but flow is detected
bool tamperDetected = false;
bool currentValveState = false;

// ISR for flow sensor
volatile unsigned long lastPulseTime = 0;
void ICACHE_RAM_ATTR flowPulseISR() {
  unsigned long now = micros();
  // Small sensors can pulse faster. 500us allows up to 2kHz which is plenty.
  if (now - lastPulseTime > 500) {
    pulseCount++;
    lastPulseTime = now;
  }
}

void triggerEmergency() {
  if (!emergencyActive) {
    Serial.println("🆘 EMERGENCY MODE ACTIVATED: Granting 1 Litre...");
    emergencyActive = true;
    emergencyValueRemaining = 1.0; // 1 Litre for Ramesh
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n====================================");
  Serial.println("Consumer Ramesh Node Starting...");
  Serial.println("====================================\n");

  // 1. Connect to WiFi using WiFiManager
  WiFi.mode(WIFI_STA);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(EMERGENCY_BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(LED_BUILTIN, HIGH);

  Serial.printf("Connecting to Wi-Fi: %s ", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  unsigned long startAttemptTime = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 20000) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nFailed to connect. Continuing in offline mode...");
  } else {
    Serial.println("\nWiFi Connected!");
    Serial.println(WiFi.localIP());
  }

  digitalWrite(LED_BUILTIN, LOW);

  // 2. Initialize Firebase
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase sign up OK");
  } else {
    Serial.printf("Firebase sign up failed: %s\n",
                  config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // Set smaller response buffer size to save RAM
  fbdo.setResponseSize(1024);

  // 3. Setup Valve Relay
  pinMode(RELAY_PIN, OUTPUT_OPEN_DRAIN);
  digitalWrite(RELAY_PIN, RELAY_OFF);

  // 4. Setup Flow Sensor
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR,
                  FALLING);
  lastFlowCalc = millis();

  // 5. Initialize MPU6050
  Wire.begin(D2, D1); // SDA, SCL
  if (!mpu.begin()) {
    Serial.println("Failed to find MPU6050 chip");
    mpuInitialized = false;
  } else {
    Serial.println("MPU6050 Found!");
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    mpuInitialized = true;

    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    baseAccelX = a.acceleration.x;
    baseAccelY = a.acceleration.y;
    baseAccelZ = a.acceleration.z;
  }

  Serial.println("Setup complete!\n");
}

void loop() {

  // 0. Check Physical Emergency Button (Ignore first 5s to prevent boot triggers)
  if (millis() > 5000 && digitalRead(EMERGENCY_BUTTON_PIN) == LOW) {
    delay(50); // Small debounce delay
    if (digitalRead(EMERGENCY_BUTTON_PIN) == LOW) {
      triggerEmergency();
    }
  }

  // 1. Check for Reset/Emergency Command (Batch Fetch to reduce blocking)
  static unsigned long lastCmdCheck = 0;
  if (Firebase.ready() &&
      (millis() - lastCmdCheck > 2000)) { // Increased to 2s to be safer
    lastCmdCheck = millis();
    yield();

    if (Firebase.RTDB.getJSON(&fbdo, F("commands"))) {
      FirebaseJson &json = fbdo.jsonObject();
      FirebaseJsonData jsonData;

      // Check System-wide Reset
      json.get(jsonData, F("resetAll"));
      if (jsonData.success && jsonData.type == "boolean" &&
          jsonData.boolValue) {
        Serial.println(F("🔄 SYSTEM RESET REQUESTED..."));
        totalLitres = 0;
        flowRate = 0;
        pulseCount = 0;
        tamperDetected = false;
        lastTamperTime = 0;
        emergencyActive = false;
        emergencyValueRemaining = 0;
        // Force update RTDB immediately
        Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/totalLitres"), 0);
        Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/flowRate"), 0);
        Firebase.RTDB.setBool(&fbdo, F("commands/resetAll"), false);
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node/triggerEmergency"), false);
        
        // Immediate Status Sync to clear red alerts
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/emergencyActive"), false);
        Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/tamperDetected"), false);
      }

      // Check Individual Emergency Trigger
      json.get(jsonData, F("consumer_node/triggerEmergency"));
      if (jsonData.success && jsonData.type == "boolean" && jsonData.boolValue) {
        triggerEmergency();
        Firebase.RTDB.setBool(&fbdo, F("commands/consumer_node/triggerEmergency"), false);
      }
    }
    yield();
  }

  // 2. Regular flow calculations
  if (millis() - lastFlowCalc >= 1000) {
    unsigned long pulseCopy;
    unsigned long elapsedMs = millis() - lastFlowCalc;
    noInterrupts();
    pulseCopy = pulseCount;
    pulseCount = 0;
    interrupts();
    float elapsedSec = elapsedMs / 1000.0;

    if (elapsedSec > 0) {
      float hz = pulseCopy / elapsedSec;
      float rawFlow = hz / flowCalibration;
      if (rawFlow > 40.0)
        rawFlow = 0;
      if (pulseCopy == 0) {
        flowRate = flowRate * 0.7;
      } else {
        flowRate = (flowRate * 0.7) + (rawFlow * 0.3);
      }
      if (flowRate < 0.01)
        flowRate = 0;
    } else {
      flowRate = 0;
    }

    float pulsesPerLitre = flowCalibration * 60.0;
    float litresThisInterval = 0;
    if (pulsesPerLitre > 0) {
      litresThisInterval = (float)pulseCopy / pulsesPerLitre;
    }

    if (litresThisInterval > 0) {
      totalLitres += litresThisInterval;
      // Handle Emergency Consumption
      if (emergencyActive) {
        emergencyValueRemaining -= litresThisInterval;
        if (emergencyValueRemaining <= 0) {
          emergencyValueRemaining = 0;
          emergencyActive = false;
          Serial.println("🆘 EMERGENCY WATER EXHAUSTED.");
        }
      }
    }

    // =========================
    // TAMPER / BYPASS DETECTION
    // =========================
    bool flowTamper = false;
    bool motionTamper = false;

    // 1. Flow detection while valve is CLOSED (pipe bypass detection)
    if (!currentValveState && flowRate > 0.3) {
      flowTamper = true;
      Serial.println("🚨 TAMPER ALERT: Flow detected while valve is CLOSED!");
    }

    // 2. Motion / Shaking detection
    if (mpuInitialized) {
      sensors_event_t a, g, temp;
      mpu.getEvent(&a, &g, &temp);
      float diffX = abs(a.acceleration.x - baseAccelX);
      float diffY = abs(a.acceleration.y - baseAccelY);
      float diffZ = abs(a.acceleration.z - baseAccelZ);
      if (diffX > 3.5 || diffY > 3.5 || diffZ > 3.5) {
        motionTamper = true;
        lastTamperTime = millis();
        Serial.println("🚨 TAMPER ALERT: Motion/Shaking detected!");
      }
      // Keep alert active for 30 seconds after motion
      if (millis() - lastTamperTime < 30000) {
        motionTamper = true;
      }
      // Update baseline slowly to account for slow tilts (drift)
      baseAccelX = baseAccelX * 0.9 + a.acceleration.x * 0.1;
      baseAccelY = baseAccelY * 0.9 + a.acceleration.y * 0.1;
      baseAccelZ = baseAccelZ * 0.9 + a.acceleration.z * 0.1;
    }
    tamperDetected = flowTamper || motionTamper;
    lastFlowCalc = millis();
  }

  // =========================
  // SETTINGS SYNC (every 10 seconds)
  // =========================
  static unsigned long lastSettingsSync = 0;
  if (Firebase.ready() &&
      (millis() - lastSettingsSync > 10000 || lastSettingsSync == 0)) {
    lastSettingsSync = millis();
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/consumerCalibration"))) {
      float newVal = fbdo.floatData();
      if (newVal > 10.0 && newVal < 1000.0) {
        flowCalibration = newVal;
      }
    }
  }

  // 3. Valve Control (Every 1 second)
  if (Firebase.ready() &&
      (millis() - lastValveCheckMillis > 1000 || lastValveCheckMillis == 0)) {
    lastValveCheckMillis = millis();
    bool govState = true;
    bool userState = true;

    // Read Gov Master Switch
    if (Firebase.RTDB.getBool(&fbdo, F("valves/consumer_node/gov"))) {
      govState = fbdo.boolData();
    }
    // Read User Switch
    if (Firebase.RTDB.getBool(&fbdo, F("valves/consumer_node/user"))) {
      userState = fbdo.boolData();
    }

    // Valve logic: Normal status OR Emergency Override
    currentValveState = (govState && userState) || emergencyActive;
    digitalWrite(RELAY_PIN, currentValveState ? RELAY_ON : RELAY_OFF);

    Serial.printf("Valve: [Gov: %s | User: %s] -> Final: %s\n",
                  govState ? "ON" : "OFF", userState ? "ON" : "OFF",
                  currentValveState ? "OPEN" : "CLOSED");
  }

  // 4. Send Real-time Data
  if (Firebase.ready() && (millis() - sendFlowPrevMillis > 1000)) {
    sendFlowPrevMillis = millis();
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/flowRate"), flowRate);
    #ifdef ESP8266
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/totalLitres"), totalLitres);
    #else
    Firebase.RTDB.setFloat(&fbdo, "sensorData/consumer_node/totalLitres", totalLitres);
    #endif
    Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/consumer_node/lastSeen"));

    // Emergency Status
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/emergencyActive"), emergencyActive);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/consumer_node/emergencyValue"), emergencyValueRemaining);
  }

  // 5. Heartbeat & Metadata (every 5 seconds)
  if (Firebase.ready() &&
      (millis() - sendDataPrevMillis > 5000 || sendDataPrevMillis == 0)) {
    sendDataPrevMillis = millis();
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/tamperDetected"),
                          tamperDetected);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/consumer_node/valveState"),
                          currentValveState);

    Serial.print(F("Flow Rate: "));
    Serial.print(flowRate);
    Serial.print(F(" L/min | Total: "));
    Serial.print(totalLitres);
    Serial.print(F(" L | Tamper: "));
    Serial.print(tamperDetected ? "YES" : "No");
    Serial.print(F(" | Emergency: "));
    Serial.println(emergencyActive ? "ACTIVE" : "Off");
    Serial.println(F("Heartbeat sent to Firebase."));
    Serial.println(F("------------------------"));
  }
}
