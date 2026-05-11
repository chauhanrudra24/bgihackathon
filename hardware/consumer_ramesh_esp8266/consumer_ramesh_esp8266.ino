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
unsigned long lastValveCheckMillis = 0;

// =========================
// VALVE PIN
// =========================
#define RELAY_PIN D2 // Relay for Solenoid Valve
#define RELAY_ON LOW   // Change to HIGH if your relay is Active-HIGH
#define RELAY_OFF HIGH // Change to LOW if your relay is Active-HIGH

void setup() {
  Serial.begin(115200);
  
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
}

void loop() {
  ArduinoOTA.handle();

  // Check Valve Status every 1 second
  if (Firebase.ready() && (millis() - lastValveCheckMillis > 1000 || lastValveCheckMillis == 0)) {
    lastValveCheckMillis = millis();
    // Using Ramesh's path: "valves/consumer_node"
    if (Firebase.RTDB.getBool(&fbdo1, "valves/consumer_node")) {
      bool valveState = fbdo1.boolData();
      digitalWrite(RELAY_PIN, valveState ? RELAY_ON : RELAY_OFF);
      Serial.printf("Valve state read from Firebase: %s (Relay PIN is %s)\n", 
          valveState ? "OPEN" : "CLOSED", 
          valveState ? (RELAY_ON == LOW ? "LOW" : "HIGH") : (RELAY_OFF == LOW ? "LOW" : "HIGH"));
    } else {
      Serial.println("Valve read error (or doesn't exist yet): " + fbdo1.errorReason());
    }
  }

  // Send Heartbeat to Firebase every 5 seconds (5000 milliseconds)
  if (Firebase.ready() && (millis() - sendDataPrevMillis > 5000 || sendDataPrevMillis == 0)) {
    sendDataPrevMillis = millis();
    
    // Using Ramesh's path: "sensorData/consumer_node/lastSeen"
    if (Firebase.RTDB.setTimestamp(&fbdo2, "sensorData/consumer_node/lastSeen")) {
      Serial.println("Heartbeat sent to Firebase.");
    } else {
      Serial.println("Firebase Write Error: " + fbdo2.errorReason());
    }
  }
}
