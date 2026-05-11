#include <WiFi.h>
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <WiFiUdp.h>
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

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// Use a static or global instance for WiFiManager on ESP32
static WiFiManager wifiManager;

unsigned long sendDataPrevMillis = 0;
unsigned long theftCheckMillis = 0;

// =========================
// SENSOR PINS
// =========================
#define TURBIDITY_PIN 33
#define TDS_PIN 32
#define FLOW_SENSOR_PIN 27  // YF-S201 Signal Pin

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

float turbidityThreshold = 3.15;

// =========================
// FLOW SENSOR (YF-S201)
// =========================
// YF-S201: ~7.5 pulses per liter per minute (450 pulses/L)
volatile unsigned long pulseCount = 0;
float flowRate = 0.0;        // L/min
float totalLitres = 0.0;     // Total litres since boot
unsigned long lastFlowCalc = 0;

// Theft Detection
float govSupplyLitres = 0.0;     // Total litres from gov supply
float consumerTotalLitres = 0.0; // Sum of all consumer usage (from Firebase)
String theftStatus = "NORMAL";   // NORMAL, SUSPICIOUS, ALERT

// IRAM_ATTR for ESP32 interrupt
void IRAM_ATTR flowPulseISR() {
  pulseCount++;
}

void setup() {
  Serial.begin(115200);
  delay(1000); // Wait for serial to stabilize
  Serial.println("\n\n====================================");
  Serial.println("JalBoard Government Node Starting...");
  Serial.println("====================================\n");

  // 1. Connect to WiFi using WiFiManager
  WiFi.mode(WIFI_STA); // Explicitly set mode for better stability
  
  // wifiManager.resetSettings(); // Uncomment to wipe stored Wi-Fi credentials

  // Set timeout for connecting to saved WiFi before starting AP
  // wifiManager.setConnectTimeout(30);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW); // LED OFF while connecting

  Serial.println("Connecting to Wi-Fi...");
  // Connects to saved Wi-Fi or sets up an Access Point named "JalBoard_GovNode_AP"
  if (!wifiManager.autoConnect("JalBoard_GovNode_AP")) {
    Serial.println("Failed to connect or timeout reached. Restarting...");
    delay(3000);
    ESP.restart(); // Reset and try again
  }

  Serial.println();
  Serial.print("Connected with IP: ");
  Serial.println(WiFi.localIP());
  Serial.println();

  digitalWrite(LED_BUILTIN, HIGH); // LED ON when connected

  // 1.5 Setup OTA
  ArduinoOTA.setHostname("JalBoard_GovNode");
  ArduinoOTA.setPassword("prince");
  ArduinoOTA.begin();
  Serial.println("OTA Ready");

  // 2. Initialize Firebase
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  // Sign up (Anonymous Authentication)
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase sign up OK");
  } else {
    Serial.printf("Firebase sign up failed: %s\n",
                  config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // 3. Setup ADC
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  // 4. Setup Flow Sensor (YF-S201)
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR, RISING);
  lastFlowCalc = millis();
  
  Serial.println("Flow Sensor (YF-S201) initialized on pin 27");
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
    
    // YF-S201: Flow rate (L/min) = Frequency (Hz) / 7.5
    // Frequency (Hz) = pulseCopy / elapsedSec
    if (elapsedSec > 0) {
      flowRate = (pulseCopy / elapsedSec) / 7.5;
    } else {
      flowRate = 0;
    }
    
    // Volume in litres for this interval
    // YF-S201: ~450 pulses per liter
    float litresThisInterval = pulseCopy / 450.0;
    totalLitres += litresThisInterval;
    govSupplyLitres += litresThisInterval;
    
    lastFlowCalc = millis();
  }

  // =========================
  // THEFT / LEAKAGE CHECK (every 30 seconds)
  // =========================
  if (Firebase.ready() && (millis() - theftCheckMillis > 30000 || theftCheckMillis == 0)) {
    theftCheckMillis = millis();
    
    // Read total consumer usage from Firebase
    float totalConsumer = 0.0;
    
    if (Firebase.RTDB.getFloat(&fbdo, "sensorData/consumer_node/totalLitres")) {
      totalConsumer += fbdo.floatData();
    }
    if (Firebase.RTDB.getFloat(&fbdo, "sensorData/consumer_node_8266/totalLitres")) {
      totalConsumer += fbdo.floatData();
    }
    
    consumerTotalLitres = totalConsumer;
    
    // Theft Detection Logic:
    // If gov supplies significantly more than consumers are receiving
    // Allow 15% tolerance for sensor inaccuracy
    float difference = govSupplyLitres - consumerTotalLitres;
    float tolerance = govSupplyLitres * 0.15;
    
    if (govSupplyLitres > 2.0) { // Only check if enough water has flowed
      if (difference > tolerance && difference > 1.0) {
        if (difference > govSupplyLitres * 0.30) {
          theftStatus = "ALERT";
          Serial.println("🚨 THEFT ALERT: Major discrepancy detected!");
        } else {
          theftStatus = "SUSPICIOUS";
          Serial.println("⚠️ SUSPICIOUS: Minor discrepancy in flow.");
        }
      } else {
        theftStatus = "NORMAL";
      }
    }
    
    // Upload theft data
    Firebase.RTDB.setString(&fbdo, "sensorData/gov_node/theftStatus", theftStatus);
    Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/govSupplyLitres", govSupplyLitres);
    Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/consumerTotalLitres", consumerTotalLitres);
    Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/flowDifference", govSupplyLitres - consumerTotalLitres);
  }

  // Send data to Firebase every 5 seconds (5000 milliseconds)
  if (Firebase.ready() &&
      (millis() - sendDataPrevMillis > 5000 || sendDataPrevMillis == 0)) {
    sendDataPrevMillis = millis();

    // =========================
    // TURBIDITY SENSOR
    // =========================
    int turbidityValue = analogRead(TURBIDITY_PIN);
    float turbidityVoltage = turbidityValue * (3.3 / 4095.0);

    String waterStatus;
    bool turbConnected = (turbidityVoltage > 0.05); // Threshold for connection
    
    if (!turbConnected) {
      waterStatus = "NOT CONNECTED";
    } else if (turbidityVoltage > turbidityThreshold) {
      waterStatus = "CLEAR";
    } else {
      waterStatus = "DIRTY";
    }

    // =========================
    // TDS SENSOR
    // =========================
    long sum = 0;
    for (int i = 0; i < 10; i++) {
      sum += analogRead(TDS_PIN);
      delay(10);
    }
    float avgValue = sum / 10.0;
    float tdsVoltage = avgValue * (3.3 / 4095.0);
    float tdsValue = (133.42 * tdsVoltage * tdsVoltage * tdsVoltage -
                      255.86 * tdsVoltage * tdsVoltage + 857.39 * tdsVoltage) *
                     0.5;

    bool tdsConnected = (tdsVoltage > 0.05); // Threshold for connection

    // =========================
    // FLOW SENSOR CONNECTION CHECK
    // =========================
    bool flowConnected = (totalLitres > 0 || flowRate > 0 || millis() < 60000);
    // If no flow detected for >60 seconds after boot, mark as not connected
    // But we also check if flow sensor has ever produced pulses

    // =========================
    // SEND TO FIREBASE
    // =========================
    bool success = true;
    
    // Send connection status
    Firebase.RTDB.setBool(&fbdo, "sensorData/gov_node/turbidityConnected", turbConnected);
    Firebase.RTDB.setBool(&fbdo, "sensorData/gov_node/tdsConnected", tdsConnected);
    Firebase.RTDB.setBool(&fbdo, "sensorData/gov_node/flowConnected", flowConnected);

    if (turbConnected) {
      Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/turbidityVoltage", turbidityVoltage);
    }
    
    if (tdsConnected) {
      Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/tdsValue", tdsValue);
    }

    // Flow data - always send
    Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/flowRate", flowRate);
    Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/totalLitres", totalLitres);

    if (!Firebase.RTDB.setString(&fbdo, "sensorData/gov_node/waterStatus", waterStatus)) {
      success = false;
      Serial.println("Firebase Write Error (status): " + fbdo.errorReason());
    }
    Firebase.RTDB.setTimestamp(&fbdo, "sensorData/gov_node/lastSeen");

    if (success) {
      Serial.println("==> Successfully sent to Firebase!");
    }

    // =========================
    // PRINT TO SERIAL
    // =========================
    Serial.print("Turbidity Voltage: ");
    Serial.print(turbidityVoltage);
    Serial.print(" V (");
    Serial.print(waterStatus);
    Serial.println(")");

    Serial.print("TDS Value: ");
    Serial.print(tdsValue);
    Serial.println(" ppm");

    Serial.print("Flow Rate: ");
    Serial.print(flowRate);
    Serial.println(" L/min");

    Serial.print("Total Litres: ");
    Serial.print(totalLitres);
    Serial.println(" L");

    Serial.print("Theft Status: ");
    Serial.println(theftStatus);
    Serial.println("------------------------");
  }
}
