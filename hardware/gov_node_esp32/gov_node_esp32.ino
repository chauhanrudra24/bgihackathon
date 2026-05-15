#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>
#include <WiFiManager.h>
#include <Ticker.h>
#include "env.h"

// ========================= FIREBASE =========================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
bool firebaseConnected = false;

// ========================= TIMING =========================
unsigned long sendDataPrevMillis = 0;
unsigned long sendFlowPrevMillis = 0;
unsigned long telemetryMillis = 0;
unsigned long lastCmdCheck = 0;

// ========================= SENSORS =========================
#define TURBIDITY_PIN 33
#define TDS_PIN 32
#define FLOW_SENSOR_PIN 27
#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

Ticker blinker;
void blink() { digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); }

// ========================= FLOW LOGIC =========================
volatile unsigned long pulseCount = 0;
float flowRate = 0.0;
float govSupplyLitres = 0.0; 
unsigned long lastFlowCalc = 0;
float flowCalibration = 98.0; 
float minFlowThreshold = 0.001; 

float turbidityVolts = 0.0;
float tdsValue = 0.0;

static float jsonToFloat(FirebaseJsonData &d) {
  if (!d.success)
    return 0.0f;
  if (d.typeNum == FirebaseJson::JSON_STRING) {
    return d.stringValue.toFloat();
  }
  return (float)d.to<double>();
}

void IRAM_ATTR flowPulseISR() {
  static unsigned long lastPulse = 0;
  unsigned long now = micros();
  if (now - lastPulse > 500) {
    pulseCount++;
    lastPulse = now;
  }
}

void logAlert(const char *node, const char *type, const char *msg) {
  if (firebaseConnected && Firebase.ready()) {
    FirebaseJson json;
    json.add("node", node);
    json.add("type", type);
    json.add("msg", msg);
    json.set("timestamp/.sv", "timestamp");
    Firebase.RTDB.pushJSON(&fbdo, F("alertLogs"), &json);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n== Gov Node Starting (Dual Mode) =="));

  pinMode(LED_BUILTIN, OUTPUT);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFiManager wm;
  wm.setAPCallback([](WiFiManager *wm) { blinker.attach(0.2, blink); });
  wm.setConfigPortalTimeout(30);

  if (!wm.autoConnect("JalBoard_GovNode_AP")) {
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

    if (Firebase.ready()) {
      if (Firebase.RTDB.getFloat(&fbdo, F("sensorData/gov_node/govSupplyLitres"))) {
        govSupplyLitres = fbdo.floatData();
        Serial.printf("Recovered System Supply: %.2f L\n", govSupplyLitres);
      }
    }
  }

  blinker.detach();
  digitalWrite(LED_BUILTIN, HIGH);

  Serial.printf("Setup OK | Heap: %d\n", ESP.getFreeHeap());

  analogSetAttenuation(ADC_11db);
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR, RISING);
  lastFlowCalc = millis();

  Serial.println(F("Gov Node Ready"));
}

void loop() {
  static unsigned long lastWifiCheck = 0;
  if (WiFi.status() != WL_CONNECTED && (millis() - lastWifiCheck > 5000)) {
    lastWifiCheck = millis();
    firebaseConnected = false;
    WiFi.reconnect();
  } else if (WiFi.status() == WL_CONNECTED) {
    firebaseConnected = true;
  }

  // ---- USB SERIAL COMMANDS ----
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    int colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      String targetNode = line.substring(0, colonIdx);
      String cmd = line.substring(colonIdx + 1);
      if (targetNode == "gov_node" && cmd == "resetData") {
        govSupplyLitres = 0; flowRate = 0; pulseCount = 0;
      }
    }
  }

  if (firebaseConnected && Firebase.ready() && (millis() - lastCmdCheck > 1500)) {
    lastCmdCheck = millis();
    if (Firebase.RTDB.getJSON(&fbdo, F("commands"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("resetAll")) && d.success && d.boolValue) {
        govSupplyLitres = 0; flowRate = 0; pulseCount = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/resetAll"), false);
      }
    }
  }

  if (millis() - lastFlowCalc >= 1000) {
    unsigned long elapsed = millis() - lastFlowCalc;
    noInterrupts();
    unsigned long pc = pulseCount;
    pulseCount = 0;
    interrupts();

    float sec = elapsed / 1000.0;
    if (sec > 0) {
      float hz = pc / sec;
      float raw = hz / flowCalibration;
      if (pc > 0) {
        flowRate = flowRate * 0.5 + raw * 0.5;
      } else {
        flowRate = 0.0;
      }
    } else {
      flowRate = 0.0;
    }
    
    if (flowRate > 0 && flowRate < minFlowThreshold) {
      flowRate = 0.0;
    }
    float ppl = flowCalibration * 60.0;
    if (ppl > 0) govSupplyLitres += (float)pc / ppl;
    lastFlowCalc = millis();
  }

  static unsigned long lastSettingsSync = 0;
  if (firebaseConnected && Firebase.ready() && (millis() - lastSettingsSync > 15000 || lastSettingsSync == 0)) {
    lastSettingsSync = millis();
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/govCalibration"))) {
      float v = fbdo.floatData();
      if (v > 10.0 && v < 1000.0) flowCalibration = v;
    }
  }

  // ---- 3. TELEMETRY AGGREGATION (every 5s) ----
  // Gov node collects consumer totals for dashboard display only.
  // NO theft detection here — that's handled by consumer ESP + dashboard.
  if (millis() - sendDataPrevMillis > 5000) {
    sendDataPrevMillis = millis();
    long tSum = 0;
    for (int i = 0; i < 10; i++) { tSum += analogRead(TURBIDITY_PIN); delayMicroseconds(100); }
    turbidityVolts = (tSum / 10.0) * (3.3 / 4095.0);
    
    long dSum = 0;
    for (int i = 0; i < 10; i++) { dSum += analogRead(TDS_PIN); delayMicroseconds(100); }
    float dVolts = (dSum / 10.0) * (3.3 / 4095.0);
    tdsValue = (133.42 * dVolts * dVolts * dVolts - 255.86 * dVolts * dVolts + 857.39 * dVolts) * 0.5;

    if (firebaseConnected && Firebase.ready()) {
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/turbidityVoltage"), turbidityVolts);
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/tdsValue"), tdsValue);
      Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/tdsConnected"), (tdsValue > 1.0));
      Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/turbidityConnected"), (turbidityVolts > 0.1));
      Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/waterStatus"), (turbidityVolts > 3.0) ? "CLEAR" : "DIRTY");
      
      // Compute network diff for Firebase
      float rameshTotal = 0, priyaTotal = 0;
      bool rTamper = false;
      if (Firebase.RTDB.getJSON(&fbdo, F("sensorData"))) {
        FirebaseJson &res = fbdo.jsonObject();
        FirebaseJsonData d;
        if (res.get(d, F("consumer_node/totalLitres"))) rameshTotal = jsonToFloat(d);
        if (res.get(d, F("consumer_node/tamperDetected"))) rTamper = d.boolValue;
        if (res.get(d, F("consumer_node_8266/totalLitres"))) priyaTotal = jsonToFloat(d);
      }

      static bool lastRTamper = false;
      if (rTamper && !lastRTamper) {
        logAlert("Ramesh", "TAMPER", "Meter displacement detected! Auto-blocking node.");
        Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node/gov"), false);
        Firebase.RTDB.setString(&fbdo, F("accounts/consumer_node/theftReason"), "Meter Tampering (MPU Tilt)");
      }
      lastRTamper = rTamper;

      float consumerTotalLitres = rameshTotal + priyaTotal;
      float flowDifference = govSupplyLitres - consumerTotalLitres;
      if (flowDifference < 0) flowDifference = 0;

      FirebaseJson statusUpdates;
      statusUpdates.set("sensorData/gov_node/govSupplyLitres", govSupplyLitres);
      statusUpdates.set("sensorData/gov_node/consumerTotalLitres", consumerTotalLitres);
      statusUpdates.set("sensorData/gov_node/flowDifference", flowDifference);
      Firebase.RTDB.updateNode(&fbdo, "/", &statusUpdates);
    }
  }

  if (millis() - sendFlowPrevMillis > 2000) {
    sendFlowPrevMillis = millis();
    
    if (firebaseConnected && Firebase.ready()) {
      Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/flowRate"), flowRate);
      Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/gov_node/lastSeen"));
    }
 
    // USB SERIAL JSON (Gov node fields)
    Serial.printf("{\"node\":\"gov_node\",\"flowRate\":%.3f,\"govSupplyLitres\":%.2f,\"turbidityVoltage\":%.2f,\"tdsValue\":%.1f,\"tdsConnected\":%s,\"turbidityConnected\":%s,\"waterStatus\":\"%s\",\"lastSeen\":%lu}\n",
      flowRate, govSupplyLitres, turbidityVolts, tdsValue, 
      (tdsValue > 1.0) ? "true" : "false", 
      (turbidityVolts > 0.1) ? "true" : "false",
      (turbidityVolts > 3.0) ? "CLEAR" : "DIRTY", millis());
  }
  }
}
