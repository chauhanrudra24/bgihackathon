#include <WiFi.h>
#include <ESPmDNS.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>
#include <Firebase_ESP_Client.h>

#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

#include <WiFiManager.h>
#include "env.h"

FirebaseData fbdo1;
FirebaseData fbdo2;
FirebaseAuth auth;
FirebaseConfig config;

unsigned long sendDataPrevMillis = 0;
unsigned long lastValveCheckMillis = 0;

// =========================
// RELAY CONFIG
// =========================
#define RELAY_PIN 26

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

void relayON() {
  // Connect pin to GND
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
}

void relayOFF() {
  // Disconnect pin (floating/open)
  pinMode(RELAY_PIN, INPUT);
}

void setup() {
  Serial.begin(115200);

  WiFiManager wifiManager;

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

  Serial.println("Connecting to WiFi...");

  if (!wifiManager.autoConnect("Consumer_Ramesh_AP")) {
    Serial.println("Failed to connect");
    delay(3000);
    ESP.restart();
  }

  Serial.println();
  Serial.print("Connected IP: ");
  Serial.println(WiFi.localIP());

  digitalWrite(LED_BUILTIN, HIGH);

  // =========================
  // OTA
  // =========================
  ArduinoOTA.setHostname("Consumer_Ramesh");
  ArduinoOTA.setPassword("prince");
  ArduinoOTA.begin();

  Serial.println("OTA Ready");

  // =========================
  // FIREBASE
  // =========================
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

  // =========================
  // RELAY INIT
  // =========================
  relayOFF();
}

void loop() {

  ArduinoOTA.handle();

  // =========================
  // CHECK VALVE STATUS
  // =========================
  if (Firebase.ready() &&
      (millis() - lastValveCheckMillis > 1000 ||
       lastValveCheckMillis == 0)) {

    lastValveCheckMillis = millis();

    if (Firebase.RTDB.getBool(&fbdo1,
                              "valves/consumer_node")) {

      bool valveState = fbdo1.boolData();

      if (valveState) {
        relayON();
        Serial.println("Valve OPEN");
      } else {
        relayOFF();
        Serial.println("Valve CLOSED");
      }

    } else {

      Serial.println("Valve read error: " +
                     fbdo1.errorReason());
    }
  }

  // =========================
  // HEARTBEAT
  // =========================
  if (Firebase.ready() &&
      (millis() - sendDataPrevMillis > 5000 ||
       sendDataPrevMillis == 0)) {

    sendDataPrevMillis = millis();

    if (Firebase.RTDB.setTimestamp(
            &fbdo2,
            "sensorData/consumer_node/lastSeen")) {

      Serial.println("Heartbeat sent");

    } else {

      Serial.println("Firebase Write Error: " +
                     fbdo2.errorReason());
    }
  }
}