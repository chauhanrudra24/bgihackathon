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
// =========================
// NETWORK & FIREBASE CONFIG
// =========================
#include "env.h"

FirebaseData fbdo1;
FirebaseData fbdo2;
FirebaseAuth auth;
FirebaseConfig config;

unsigned long sendDataPrevMillis = 0;
unsigned long sendFlowPrevMillis = 0;
unsigned long lastValveCheckMillis = 0;

// =========================
// VALVE PIN
// =========================
#define RELAY_PIN D2 // Relay for Solenoid Valve
#define RELAY_ON LOW   // Change to HIGH if your relay is Active-HIGH
#define RELAY_OFF HIGH // Change to LOW if your relay is Active-HIGH

// =========================
// FLOW SENSOR (1/8 inch)
// =========================
#define FLOW_SENSOR_PIN D5  // 1/8" Flow Sensor Signal Pin

// 1/8" Flow Sensor calibration: ~21 pulses per litre (varies by model)
// Adjust PULSES_PER_LITRE based on your specific sensor's datasheet
#define PULSES_PER_LITRE 5880.0
#define FLOW_CALIBRATION 98.0  // pulses per second per L/min (Standard for YF-S401 / small G1/8)

volatile unsigned long pulseCount = 0;
float flowRate = 0.0;        // L/min (Smoothed)
float totalLitres = 0.0;     // Total litres since boot
unsigned long lastFlowCalc = 0;
float flowCalibration = 98.0; // Default for small G1/8

// Tamper detection - if valve is CLOSED but flow is detected
bool tamperDetected = false;
bool currentValveState = false;

// ISR for flow sensor
volatile unsigned long lastPulseTime = 0;
void ICACHE_RAM_ATTR flowPulseISR() {
  unsigned long now = micros();
  // Small sensors can pulse faster. 200us allows up to 5kHz.
  if (now - lastPulseTime > 200) {
    pulseCount++;
    lastPulseTime = now;
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
  WiFiManager wifiManager;
  
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // ESP8266 LED is Active LOW, so HIGH means OFF

  Serial.println("Connecting to Wi-Fi...");
  // Connects to saved Wi-Fi or sets up an Access Point named "Consumer_Ramesh_AP"
  if (!wifiManager.autoConnect("Consumer_Ramesh_AP")) {
    Serial.println("Failed to connect, restarting...");
    delay(3000);
    ESP.restart(); // Reset and try again
  }

  Serial.println();
  Serial.print("Connected with IP: ");
  Serial.println(WiFi.localIP());
  Serial.println();

  digitalWrite(LED_BUILTIN, LOW); // LOW means ON for ESP8266

  // 1.5 Setup OTA
  ArduinoOTA.setHostname("Consumer_Ramesh");
  ArduinoOTA.setPassword("prince");
  ArduinoOTA.begin();
  Serial.println("OTA Ready");

  // 2. Initialize Firebase
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  // Sign up (Anonymous Authentication)
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase sign up OK");
  }
  else {
    Serial.printf("Firebase sign up failed: %s\n", config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  
  // 3. Setup Valve Relay
  pinMode(RELAY_PIN, OUTPUT_OPEN_DRAIN); // Using Open-Drain for 5V relays
  digitalWrite(RELAY_PIN, RELAY_OFF); // Default OFF

  // 4. Setup Flow Sensor
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR, RISING);
  lastFlowCalc = millis();

  Serial.println("Flow Sensor (1/8 inch) initialized on D5");
  Serial.println("Setup complete!\n");
}

void loop() {
  ArduinoOTA.handle();

  // =========================
  // CALCULATE FLOW RATE (every 1 second)
  // =========================
  if (millis() - lastFlowCalc >= 1000) {
    unsigned long pulseCopy;
    unsigned long elapsedMs = millis() - lastFlowCalc;
    
    noInterrupts();
    pulseCopy = pulseCount;
    pulseCount = 0;
    interrupts();
    
    float elapsedSec = elapsedMs / 1000.0;
    
    // Flow rate (L/min) = Frequency (Hz) / flowCalibration
    if (elapsedSec > 0) {
      float hz = pulseCopy / elapsedSec;
      float rawFlow = hz / flowCalibration;
      
      // Noise Filter for small sensor
      if (rawFlow > 40.0) {
        rawFlow = 0;
      }
      
      // Better Smoothing Filter (Alpha = 0.15 for high stability)
      if (pulseCopy == 0) {
        flowRate = flowRate * 0.5; // Fast decay
        if (flowRate < 0.05) flowRate = 0;
      } else {
        flowRate = (flowRate * 0.85) + (rawFlow * 0.15);
      }
      
      if (flowRate < 0.05) flowRate = 0;
    } else {
      flowRate = 0;
    }
    
    // Volume in litres for this interval
    // Dynamic calculation: pulses per litre = flowCalibration * 60
    float pulsesPerLitre = flowCalibration * 60.0;
    float litresThisInterval = 0;
    if (pulsesPerLitre > 0) {
      litresThisInterval = (float)pulseCopy / pulsesPerLitre;
    }
    
    if (litresThisInterval > 0) {
      totalLitres += litresThisInterval;
    }
    
    // =========================
    // TAMPER / BYPASS DETECTION
    // =========================
    // If the valve is CLOSED but water is still flowing
    if (!currentValveState && flowRate > 0.3) {
      tamperDetected = true;
      Serial.println("🚨 TAMPER ALERT: Flow detected while valve is CLOSED!");
    } else if (currentValveState || flowRate < 0.1) {
      tamperDetected = false;
    }
    
    lastFlowCalc = millis();
  }

  // =========================
  // RESET COMMAND LISTENER
  // =========================
  static unsigned long lastResetCheck = 0;
  if (Firebase.ready() && (millis() - lastResetCheck > 2500)) {
    lastResetCheck = millis();
    if (Firebase.RTDB.getBool(&fbdo1, "commands/resetAll")) {
      if (fbdo1.boolData()) {
        Serial.println("🔄 RESET COMMAND RECEIVED! Clearing totals...");
        totalLitres = 0;
        pulseCount = 0;
        Firebase.RTDB.setFloat(&fbdo1, "sensorData/consumer_node/totalLitres", 0);
      }
    }
  }

  // =========================
  // SETTINGS SYNC (every 10 seconds)
  // =========================
  static unsigned long lastSettingsSync = 0;
  if (Firebase.ready() && (millis() - lastSettingsSync > 10000 || lastSettingsSync == 0)) {
    lastSettingsSync = millis();
    if (Firebase.RTDB.getFloat(&fbdo1, "settings/consumerCalibration")) {
      float newVal = fbdo1.floatData();
      if (newVal > 10.0 && newVal < 1000.0) {
        flowCalibration = newVal;
      }
    }
  }

  // Check Valve Status every 1 second
  if (Firebase.ready() && (millis() - lastValveCheckMillis > 1000 || lastValveCheckMillis == 0)) {
    lastValveCheckMillis = millis();
    
    bool govState = true;
    bool userState = true;
    
    // Read Gov Master Switch
    if (Firebase.RTDB.getBool(&fbdo1, "valves/consumer_node/gov")) {
      govState = fbdo1.boolData();
    }
    
    // Read User Switch
    if (Firebase.RTDB.getBool(&fbdo1, "valves/consumer_node/user")) {
      userState = fbdo1.boolData();
    }
    
    currentValveState = govState && userState;
    digitalWrite(RELAY_PIN, currentValveState ? RELAY_ON : RELAY_OFF);
    
    Serial.printf("Valve: [Gov: %s | User: %s] -> Final: %s\n", 
                  govState ? "ON" : "OFF", 
                  userState ? "ON" : "OFF", 
                  currentValveState ? "OPEN" : "CLOSED");
  }

  // =========================
  // SEND FLOW DATA (every 1 second for real-time feel)
  // =========================
  if (Firebase.ready() && (millis() - sendFlowPrevMillis > 1000 || sendFlowPrevMillis == 0)) {
    sendFlowPrevMillis = millis();
    Firebase.RTDB.setFloat(&fbdo2, "sensorData/consumer_node/flowRate", flowRate);
    Firebase.RTDB.setFloat(&fbdo2, "sensorData/consumer_node/totalLitres", totalLitres);
    Firebase.RTDB.setTimestamp(&fbdo2, "sensorData/consumer_node/lastSeen");
  }

  // Send other data to Firebase every 5 seconds (5000 milliseconds)
  if (Firebase.ready() && (millis() - sendDataPrevMillis > 5000 || sendDataPrevMillis == 0)) {
    sendDataPrevMillis = millis();
    
    // Using Ramesh's path: "sensorData/consumer_node/"
    Firebase.RTDB.setBool(&fbdo2, "sensorData/consumer_node/tamperDetected", tamperDetected);
    Firebase.RTDB.setBool(&fbdo2, "sensorData/consumer_node/valveState", currentValveState);
    
    Serial.print("Flow Rate: ");
    Serial.print(flowRate);
    Serial.print(" L/min | Total: ");
    Serial.print(totalLitres);
    Serial.print(" L | Tamper: ");
    Serial.println(tamperDetected ? "YES" : "No");
    Serial.println("Heartbeat sent to Firebase.");
    Serial.println("------------------------");
  }
}
