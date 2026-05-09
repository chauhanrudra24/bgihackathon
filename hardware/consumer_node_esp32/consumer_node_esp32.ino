#include <WiFi.h>
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

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

unsigned long sendDataPrevMillis = 0;

// =========================
// SENSOR PINS
// =========================
#define TURBIDITY_PIN 34
#define TDS_PIN 35
#define RELAY_PIN 14 // Relay for Solenoid Valve

float turbidityThreshold = 3.15;

void setup() {
  Serial.begin(115200);
  
  // 1. Connect to WiFi using WiFiManager
  WiFiManager wifiManager;
  
  // wifiManager.resetSettings(); // Uncomment to wipe stored Wi-Fi credentials

  Serial.println("Connecting to Wi-Fi...");
  // Connects to saved Wi-Fi or sets up an Access Point named "WaterQuality_AP"
  if (!wifiManager.autoConnect("WaterQuality_AP")) {
    Serial.println("Failed to connect, restarting...");
    delay(3000);
    ESP.restart(); // Reset and try again
  }

  Serial.println();
  Serial.print("Connected with IP: ");
  Serial.println(WiFi.localIP());
  Serial.println();

  // 1.5 Setup OTA
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
  
  // 3. Setup ADC
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  // 4. Setup Valve Relay
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW); // Default OFF
}

void loop() {
  ArduinoOTA.handle();

  // Read Valve Status instantly from Firebase (no delay needed for this)
  if (Firebase.ready()) {
    bool valveState = false;
    if (Firebase.RTDB.getBool(&fbdo, "valves/consumer_node")) {
      valveState = fbdo.boolData();
      digitalWrite(RELAY_PIN, valveState ? HIGH : LOW);
    }
  }

  // Send data to Firebase every 5 seconds (5000 milliseconds)
  if (Firebase.ready() && (millis() - sendDataPrevMillis > 5000 || sendDataPrevMillis == 0)) {
    sendDataPrevMillis = millis();
    
    // =========================
    // TURBIDITY SENSOR
    // =========================
    int turbidityValue = analogRead(TURBIDITY_PIN);
    float turbidityVoltage = turbidityValue * (3.3 / 4095.0);

    String waterStatus;
    if(turbidityVoltage > turbidityThreshold) {
      waterStatus = "CLEAR";
    }
    else {
      waterStatus = "DIRTY";
    }

    // =========================
    // TDS SENSOR
    // =========================
    long sum = 0;
    for(int i = 0; i < 10; i++) {
      sum += analogRead(TDS_PIN);
      delay(10);
    }
    float avgValue = sum / 10.0;
    float tdsVoltage = avgValue * (3.3 / 4095.0);
    float tdsValue = (133.42 * tdsVoltage * tdsVoltage * tdsVoltage
                    - 255.86 * tdsVoltage * tdsVoltage
                    + 857.39 * tdsVoltage) * 0.5;

    // =========================
    // SEND TO FIREBASE
    // =========================
    bool success = true;
    if(!Firebase.RTDB.setFloat(&fbdo, "sensorData/consumer_node/turbidityVoltage", turbidityVoltage)) {
      success = false;
      Serial.println("Firebase Write Error (turbidity): " + fbdo.errorReason());
    }
    if(!Firebase.RTDB.setString(&fbdo, "sensorData/consumer_node/waterStatus", waterStatus)) {
      success = false;
      Serial.println("Firebase Write Error (status): " + fbdo.errorReason());
    }
    if(!Firebase.RTDB.setFloat(&fbdo, "sensorData/consumer_node/tdsValue", tdsValue)) {
      success = false;
      Serial.println("Firebase Write Error (TDS): " + fbdo.errorReason());
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
    Serial.println("------------------------");
  }
}
