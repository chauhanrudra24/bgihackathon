#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>
#include <Firebase_ESP_Client.h>

// Provide the token generation process info.
#include "addons/TokenHelper.h"
// Provide the RTDB payload printing info and other helper functions.
#include "addons/RTDBHelper.h"

#include <WiFiManager.h>
#include <Ticker.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
// =========================
// NETWORK & FIREBASE CONFIG
// =========================
#include "env.h"

FirebaseData fbdo1;
FirebaseData fbdo2;
FirebaseData fbdo_cmd;
FirebaseAuth auth;
FirebaseConfig config;

unsigned long sendDataPrevMillis = 0;
unsigned long lastValveCheckMillis = 0;
Ticker blinker;

void blink() {
  digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
}

Adafruit_MPU6050 mpu;
bool mpuInitialized = false;
unsigned long lastTamperTime = 0;
float baseAccelX, baseAccelY, baseAccelZ;

// Callback when entering config mode
void configModeCallback (WiFiManager *myWiFiManager) {
  Serial.println("Entered config mode");
  Serial.println(WiFi.softAPIP());
  Serial.println(myWiFiManager->getConfigPortalSSID());
  blinker.attach(0.2, blink); // Blink fast (200ms) in AP mode
}

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
int emergencySecondsRemaining = 0;
unsigned long lastEmergencyDec = 0;

// =========================
// FLOW SENSOR (YF-S401 6mm)
// =========================
#define FLOW_SENSOR_PIN D6  // Standardized wiring
#define FLOW_CALIBRATION 98.0 // 5880 pulses/L
volatile unsigned long pulseCount = 0;
float flowRate = 0.0;
float totalLitres = 0.0;
unsigned long lastFlowCalc = 0;
float flowCalibration = 98.0;

// Tamper detection
bool tamperDetected = false;
bool currentValveState = false;

void triggerEmergency() {
  if (!emergencyActive) {
    Serial.println("🆘 EMERGENCY MODE ACTIVATED: Granting 60 Seconds...");
    emergencyActive = true;
    emergencySecondsRemaining = 60; // 1 Minute for Priya
    lastEmergencyDec = millis();
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n====================================");
  Serial.println("Consumer Priya Node (Valve Only) Starting...");
  Serial.println("====================================\n");
  
  // 1. Connect to WiFi using WiFiManager
  WiFi.mode(WIFI_STA);
  WiFiManager wifiManager;
  
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(EMERGENCY_BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(LED_BUILTIN, HIGH);

  wifiManager.setAPCallback(configModeCallback);

  Serial.println("Connecting to Wi-Fi...");
  if (!wifiManager.autoConnect("Consumer_Priya_AP")) {
    Serial.println("Failed to connect, restarting...");
    delay(3000);
    ESP.restart();
  }

  blinker.detach();
  digitalWrite(LED_BUILTIN, LOW); 

  // 1.5 Setup OTA
  ArduinoOTA.setHostname("Consumer_Priya");
  ArduinoOTA.setPassword("prince");
  ArduinoOTA.begin();
  Serial.println("OTA Ready");

  // 2. Initialize Firebase
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase sign up OK");
  } else {
    Serial.printf("Firebase sign up failed: %s\n", config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  
  // 3. Setup Valve Relay
  pinMode(RELAY_PIN, OUTPUT_OPEN_DRAIN);
  digitalWrite(RELAY_PIN, RELAY_OFF);

  // 4. Initialize MPU6050
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

  // 5. Setup Flow Sensor
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR, FALLING);

  Serial.println("Setup complete!\n");
}

// ISR for flow sensor
volatile unsigned long lastPulseTime = 0;
void ICACHE_RAM_ATTR flowPulseISR() {
  unsigned long now = micros();
  if (now - lastPulseTime > 200) {
    pulseCount++;
    lastPulseTime = now;
  }
}

void loop() {
  ArduinoOTA.handle();

  // 0. Check Physical Emergency Button
  if (digitalRead(EMERGENCY_BUTTON_PIN) == LOW) {
    triggerEmergency();
  }

  // 1. Check for Commands
  static unsigned long lastCmdCheck = 0;
  if (Firebase.ready() && (millis() - lastCmdCheck > 1000)) {
    lastCmdCheck = millis();
    
    // Reset All
    if (Firebase.RTDB.getBool(&fbdo_cmd, "commands/resetAll")) {
      if (fbdo_cmd.boolData()) {
        emergencyActive = false; emergencySecondsRemaining = 0;
        tamperDetected = false; lastTamperTime = 0;
      }
    }

    // Individual Emergency Trigger
    if (Firebase.RTDB.getBool(&fbdo_cmd, "commands/consumer_node_8266/triggerEmergency")) {
      if (fbdo_cmd.boolData()) {
        triggerEmergency();
        Firebase.RTDB.setBool(&fbdo_cmd, "commands/consumer_node_8266/triggerEmergency", false);
      }
    }
  }

  // 2. Emergency Timer Management
  if (emergencyActive && (millis() - lastEmergencyDec >= 1000)) {
    lastEmergencyDec = millis();
    emergencySecondsRemaining--;
    if (emergencySecondsRemaining <= 0) {
      emergencySecondsRemaining = 0;
      emergencyActive = false;
      Serial.println("🆘 EMERGENCY TIMER FINISHED.");
    }
  }

  // 3. Tamper detection
  static unsigned long lastMPUCheck = 0;
  if (mpuInitialized && (millis() - lastMPUCheck > 500)) {
    lastMPUCheck = millis();
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    float diffX = abs(a.acceleration.x - baseAccelX);
    float diffY = abs(a.acceleration.y - baseAccelY);
    float diffZ = abs(a.acceleration.z - baseAccelZ);
    
    if (diffX > 3.5 || diffY > 3.5 || diffZ > 3.5) {
      tamperDetected = true;
      lastTamperTime = millis();
    }
    if (lastTamperTime > 0 && millis() - lastTamperTime > 30000) {
      tamperDetected = false;
      lastTamperTime = 0;
    }
    baseAccelX = baseAccelX * 0.9 + a.acceleration.x * 0.1;
    baseAccelY = baseAccelY * 0.9 + a.acceleration.y * 0.1;
    baseAccelZ = baseAccelZ * 0.9 + a.acceleration.z * 0.1;
  }

  // 4. Valve & Command Status Logic (Batch Fetch to reduce blocking)
  if (Firebase.ready() && (millis() - lastValveCheckMillis > 2000)) {
    lastValveCheckMillis = millis();
    yield();

    if (Firebase.RTDB.getJSON(&fbdo1, "commands")) {
       FirebaseJson &json = fbdo1.jsonObject();
       FirebaseJsonData jsonData;
       
       // System Reset
       json.get(jsonData, "resetAll");
       if (jsonData.success && jsonData.type == "boolean" && jsonData.boolValue) {
         totalLitres = 0;
         flowRate = 0;
         pulseCount = 0;
         tamperDetected = false;
         lastTamperTime = 0;
         // Force update
         Firebase.RTDB.setFloat(&fbdo1, "sensorData/consumer_node_8266/totalLitres", 0);
       }

       // Individual Emergency
       json.get(jsonData, "consumer_node_8266/triggerEmergency");
       if (jsonData.success && jsonData.type == "boolean" && jsonData.boolValue) {
          emergencyActive = true;
          emergencySecondsRemaining = 60; // 1 min override
          Firebase.RTDB.setBool(&fbdo1, "commands/consumer_node_8266/triggerEmergency", false);
       }
    }

    // Check Valves
    bool govState = true;
    bool userState = true;
    if (Firebase.RTDB.getBool(&fbdo1, "valves/consumer_node_8266/gov")) govState = fbdo1.boolData();
    if (Firebase.RTDB.getBool(&fbdo1, "valves/consumer_node_8266/user")) userState = fbdo1.boolData();
    
    currentValveState = (govState && userState) || emergencyActive;
    digitalWrite(RELAY_PIN, currentValveState ? RELAY_ON : RELAY_OFF);
    yield();
  }

  // 5. Regular flow calculations
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
      if (rawFlow > 40.0) rawFlow = 0;
      flowRate = (flowRate * 0.7) + (rawFlow * 0.3);
      if (flowRate < 0.05) flowRate = 0;
    } else {
      flowRate = 0;
    }

    float pulsesPerLitre = flowCalibration * 60.0;
    if (pulsesPerLitre > 0) {
      totalLitres += (float)pulseCopy / pulsesPerLitre;
    }
    lastFlowCalc = millis();
  }

  // 5. Sync Data (every 5 seconds — valve-only node doesn't need 1s updates)
  if (Firebase.ready() && (millis() - sendDataPrevMillis > 5000)) {
    sendDataPrevMillis = millis();
    Firebase.RTDB.setBool(&fbdo2, "sensorData/consumer_node_8266/tamperDetected", tamperDetected);
    Firebase.RTDB.setBool(&fbdo2, "sensorData/consumer_node_8266/valveState", currentValveState);
    Firebase.RTDB.setTimestamp(&fbdo2, "sensorData/consumer_node_8266/lastSeen");
    
    Firebase.RTDB.setFloat(&fbdo2, "sensorData/consumer_node_8266/flowRate", flowRate);
    Firebase.RTDB.setFloat(&fbdo2, "sensorData/consumer_node_8266/totalLitres", totalLitres);
    
    // Emergency Status
    Firebase.RTDB.setBool(&fbdo2, "sensorData/consumer_node_8266/emergencyActive", emergencyActive);
    Firebase.RTDB.setFloat(&fbdo2, "sensorData/consumer_node_8266/emergencyValue", emergencySecondsRemaining);
    
    Serial.printf("Status Sent | Valve: %s | Tamper: %s | Emergency: %s\n", 
                  currentValveState ? "OPEN" : "CLOSED", 
                  tamperDetected ? "YES" : "No",
                  emergencyActive ? "ACTIVE" : "Off");
  }
}
