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

// =========================
// SENSOR PINS
// =========================
#define TURBIDITY_PIN 33
#define TDS_PIN 32

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

float turbidityThreshold = 3.15;

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

  // Callback for when AP mode is entered
  /* 
  wifiManager.setAPCallback([](WiFiManager *wm) {
    Serial.println("------------------------------------");
    Serial.println("WIFI MANAGER: Entering Config Portal");
    Serial.print("AP SSID: ");
    Serial.println(wm->getConfigPortalSSID());
    Serial.print("AP IP:   ");
    Serial.println(WiFi.softAPIP());
    Serial.println("------------------------------------");
  });
  */

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW); // LED OFF while connecting

  Serial.println("Connecting to Wi-Fi...");
  // Connects to saved Wi-Fi or sets up an Access Point named
  // "JalBoard_GovNode_AP"
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
}

void loop() {
  ArduinoOTA.handle();

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
    // SEND TO FIREBASE
    // =========================
    bool success = true;
    
    // Send connection status
    Firebase.RTDB.setBool(&fbdo, "sensorData/gov_node/turbidityConnected", turbConnected);
    Firebase.RTDB.setBool(&fbdo, "sensorData/gov_node/tdsConnected", tdsConnected);

    if (turbConnected) {
      Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/turbidityVoltage", turbidityVoltage);
    }
    
    if (tdsConnected) {
      Firebase.RTDB.setFloat(&fbdo, "sensorData/gov_node/tdsValue", tdsValue);
    }

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
    Serial.println("------------------------");
  }
}
