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
#include <Ticker.h>
// =========================
// NETWORK & FIREBASE CONFIG
// =========================
#include "env.h"

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// Use a static or global instance for WiFiManager on ESP32
static WiFiManager wifiManager;
Ticker blinker;

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

void blink() {
  digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
}

// Callback when entering config mode
void configModeCallback (WiFiManager *myWiFiManager) {
  Serial.println("Entered config mode");
  Serial.println(WiFi.softAPIP());
  Serial.println(myWiFiManager->getConfigPortalSSID());
  blinker.attach(0.2, blink); // Blink fast (200ms) in AP mode
}

unsigned long sendDataPrevMillis = 0;
unsigned long sendFlowPrevMillis = 0;
unsigned long theftCheckMillis = 0;

// =========================
// SENSOR PINS
// =========================
#define TURBIDITY_PIN 33
#define TDS_PIN 32
#define FLOW_SENSOR_PIN 27  // Standard Flow Sensor Signal Pin


float turbidityThreshold = 3.15;

// =========================
// FLOW SENSOR (YF-S401)
// =========================
// Standard Flow Sensor: ~96 pulses per liter per minute
volatile unsigned long pulseCount = 0;
float flowRate = 0.0;        // L/min (Smoothed)
float totalLitres = 0.0;     // Total litres since boot
unsigned long lastFlowCalc = 0;
float flowCalibration = 98.0; // Calibrated for YF-S401 (6mm ID)

// Theft Detection
float govSupplyLitres = 0.0;     // Total litres from gov supply
float consumerTotalLitres = 0.0; // Sum of all consumer usage (from Firebase)
String theftStatus = "NORMAL";   // NORMAL, SUSPICIOUS, ALERT

// IRAM_ATTR for ESP32 interrupt
volatile unsigned long lastPulseTime = 0;
void IRAM_ATTR flowPulseISR() {
  unsigned long now = micros();
  // Standard sensors don't pulse faster than 1-2kHz. 
  // 500us debounce filters out noise > 2kHz.
  if (now - lastPulseTime > 500) {
    pulseCount++;
    lastPulseTime = now;
  }
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

  // Set callback for when AP mode starts
  wifiManager.setAPCallback(configModeCallback);

  Serial.println("Connecting to Wi-Fi...");
  // Connects to saved Wi-Fi or sets up an Access Point named "JalBoard_GovNode_AP"
  if (!wifiManager.autoConnect("JalBoard_GovNode_AP")) {
    Serial.println("Failed to connect or timeout reached. Restarting...");
    delay(3000);
    ESP.restart(); // Reset and try again
  }

  // Once connected, stop blinking and keep LED ON
  blinker.detach();
  digitalWrite(LED_BUILTIN, HIGH); 

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

  // Set smaller response buffer size
  fbdo.setResponseSize(1024);

  // 3. Setup ADC
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  // 4. Setup Flow Sensor (YF-S201)
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR, RISING);
  lastFlowCalc = millis();
  
  Serial.println("Flow Sensor initialized on pin 27");
  Serial.println("Setup complete!\n");
}

void loop() {
  ArduinoOTA.handle();

  // 1. Check for Commands (Batch Fetch to reduce blocking)
  static unsigned long lastCmdCheck = 0;
  if (Firebase.ready() && (millis() - lastCmdCheck > 1000)) {
    lastCmdCheck = millis();
    if (Firebase.RTDB.getJSON(&fbdo, F("commands"))) {
      FirebaseJson &json = fbdo.jsonObject();
      FirebaseJsonData jsonData;
      
      // System Reset
      json.get(jsonData, F("resetAll"));
      if (jsonData.success && jsonData.type == "boolean" && jsonData.boolValue) {
        Serial.println(F("🔄 SYSTEM RESET REQUESTED..."));
        totalLitres = 0;
        govSupplyLitres = 0;
        flowRate = 0;
        pulseCount = 0;
        consumerTotalLitres = 0;
        theftStatus = "NORMAL";
        // Force update status immediately
        Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/totalLitres"), 0);
        Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/flowRate"), 0);
        Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/govSupplyLitres"), 0);
        Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/theftStatus"), F("NORMAL"));
      }
    }
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
    
    // Flow rate (L/min) = Frequency (Hz) / flowCalibration
    if (elapsedSec > 0) {
      float hz = pulseCopy / elapsedSec;
      float rawFlow = hz / flowCalibration;
      
      if (rawFlow > 80.0) {
        rawFlow = 0; 
      }
      
      // Improved Smoothing Filter
      if (pulseCopy == 0) {
        flowRate = flowRate * 0.7; // Gradual decay when no pulses
      } else {
        // Exponential Smoothing (Alpha = 0.3)
        flowRate = (flowRate * 0.7) + (rawFlow * 0.3);
      }
      
      // Sensitive noise floor
      if (flowRate < 0.05) flowRate = 0;
    } else {
      flowRate = 0;
    }
    
    // Volume in litres for this interval
    float pulsesPerLitre = flowCalibration * 60.0;
    float litresThisInterval = 0;
    if (pulsesPerLitre > 0) {
      litresThisInterval = (float)pulseCopy / pulsesPerLitre;
    }
    
    if (litresThisInterval > 0) {
      totalLitres += litresThisInterval;
      govSupplyLitres += litresThisInterval;
    }
    
    lastFlowCalc = millis();
  }

  // =========================
  // SETTINGS SYNC (every 10 seconds)
  // =========================
  static unsigned long lastSettingsSync = 0;
    }
  }

  // (Consolidated into block above)

  // =========================
  // THEFT / LEAKAGE CHECK (every 30 seconds)
  // =========================
  if (Firebase.ready() && (millis() - theftCheckMillis > 30000 || theftCheckMillis == 0)) {
    theftCheckMillis = millis();
    
    // Read total consumer usage from Firebase
    float totalConsumer = 0.0;
    
    if (Firebase.RTDB.getFloat(&fbdo, F("sensorData/consumer_node/totalLitres"))) {
      totalConsumer += fbdo.floatData();
    }
    if (Firebase.RTDB.getFloat(&fbdo, F("sensorData/consumer_node_8266/totalLitres"))) {
      totalConsumer += fbdo.floatData();
    }
    
    consumerTotalLitres = totalConsumer;
    
    // Read tamper status from consumers
    bool rameshTamper = false;
    bool priyaTamper = false;
    if (Firebase.RTDB.getBool(&fbdo, F("sensorData/consumer_node/tamperDetected"))) {
      rameshTamper = fbdo.boolData();
    }
    if (Firebase.RTDB.getBool(&fbdo, F("sensorData/consumer_node_8266/tamperDetected"))) {
      priyaTamper = fbdo.boolData();
    }

    if (rameshTamper) Serial.println("🚨 ALERT: Tamper detected at Ramesh's node!");
    if (priyaTamper) Serial.println("🚨 ALERT: Tamper detected at Priya's node!");
    
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
    Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/theftStatus"), theftStatus);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/govSupplyLitres"), govSupplyLitres);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/consumerTotalLitres"), consumerTotalLitres);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/flowDifference"), govSupplyLitres - consumerTotalLitres);
  }

  // =========================
  // SEND FLOW DATA (every 1 second for real-time feel)
  // =========================
  if (Firebase.ready() && (millis() - sendFlowPrevMillis > 1000 || sendFlowPrevMillis == 0)) {
    sendFlowPrevMillis = millis();
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/flowRate"), flowRate);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/totalLitres"), totalLitres);
    Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/gov_node/lastSeen"));
  }

  // Send other data to Firebase every 5 seconds
  if (Firebase.ready() &&
      (millis() - sendDataPrevMillis > 5000 || sendDataPrevMillis == 0)) {
    sendDataPrevMillis = millis();

    // TURBIDITY SENSOR (Averaged over 20 samples to stop random jumping)
    long turbSum = 0;
    for (int i = 0; i < 20; i++) {
      turbSum += analogRead(TURBIDITY_PIN);
      delay(2);
    }
    float turbidityVoltage = (turbSum / 20.0) * (3.3 / 4095.0);

    String waterStatus;
    bool turbConnected = (turbidityVoltage > 0.1); // 0.1V threshold for connection
    
    if (!turbConnected) {
      waterStatus = "NOT CONNECTED";
    } else if (turbidityVoltage > turbidityThreshold) {
      waterStatus = "CLEAR";
    } else {
      waterStatus = "DIRTY";
    }

    // TDS SENSOR (Averaged over 20 samples for stability)
    long tdsSum = 0;
    for (int i = 0; i < 20; i++) {
      tdsSum += analogRead(TDS_PIN);
      delay(2);
    }
    float tdsVoltage = (tdsSum / 20.0) * (3.3 / 4095.0);
    
    // Convert voltage to ppm (gravity formula)
    float tdsValue = (133.42 * tdsVoltage * tdsVoltage * tdsVoltage -
                      255.86 * tdsVoltage * tdsVoltage + 857.39 * tdsVoltage) *
                     0.5;

    bool tdsConnected = (tdsVoltage > 0.1); // 0.1V threshold for connection

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
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/turbidityConnected"), turbConnected);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/tdsConnected"), tdsConnected);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/flowConnected"), flowConnected);

    if (turbConnected) {
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/turbidityVoltage"), turbidityVoltage);
    }
    
    if (tdsConnected) {
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/tdsValue"), tdsValue);
    }

    if (!Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/waterStatus"), waterStatus)) {
      success = false;
      Serial.println(F("Firebase Write Error (status): ") + fbdo.errorReason());
    }

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
