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
float govSupplyLitres = 0.0; // Total litres passed through main supply
unsigned long lastFlowCalc = 0;
float flowCalibration = 98.0; // Configurable via Firebase
float minFlowThreshold = 0.001; // Configurable via Firebase (Binary Rule default)

// NOTE: Theft detection has been REMOVED from the gov node entirely.
// The consumer ESP now sends a `theftCandidate` flag (true when consumer
// flow == 0 for 5 continuous seconds). The Dashboard combines gov flow > 0
// AND theftCandidate == true to determine theft. This eliminates all
// false-positive theft detections caused by timing mismatches between nodes.

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
  FirebaseJson json;
  json.add("node", node);
  json.add("type", type);
  json.add("msg", msg);
  json.set("timestamp/.sv", "timestamp");
  Firebase.RTDB.pushJSON(&fbdo, F("alertLogs"), &json);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n== Gov Node Starting =="));

  pinMode(LED_BUILTIN, OUTPUT);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFiManager wm;
  wm.setAPCallback([](WiFiManager *wm) { blinker.attach(0.2, blink); });

  if (!wm.autoConnect("JalBoard_GovNode_AP")) {
    delay(3000);
    ESP.restart();
  }
  blinker.detach();
  digitalWrite(LED_BUILTIN, HIGH);

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Sign-up Success");
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

  Serial.printf("Setup OK | Heap: %d\n", ESP.getFreeHeap());

  analogSetAttenuation(ADC_11db);
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), flowPulseISR, RISING);
  lastFlowCalc = millis();

  Serial.println(F("Gov Node Ready"));
}

void loop() {
  static unsigned long lastWifiCheck = 0;
  if (WiFi.status() != WL_CONNECTED && (millis() - lastWifiCheck > 2000)) {
    lastWifiCheck = millis();
    Serial.println("WiFi Lost. Reconnecting...");
    WiFi.reconnect();
  }

  if (Firebase.ready() && (millis() - lastCmdCheck > 1500)) {
    lastCmdCheck = millis();
    if (Firebase.RTDB.getJSON(&fbdo, F("commands"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("resetAll")) && d.success && d.boolValue) {
        govSupplyLitres = 0; flowRate = 0; pulseCount = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/resetAll"), false);
        Serial.println(F("System reset received."));
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

  // ---- 2.5. SETTINGS SYNC (every 15s) ----
  static unsigned long lastSettingsSync = 0;
  if (Firebase.ready() && (millis() - lastSettingsSync > 15000 || lastSettingsSync == 0)) {
    lastSettingsSync = millis();
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/govCalibration"))) {
      float v = fbdo.floatData();
      if (v > 10.0 && v < 1000.0) flowCalibration = v;
    }
    if (Firebase.RTDB.getFloat(&fbdo, F("settings/minFlowThreshold"))) {
      float mf = fbdo.floatData();
      if (mf >= 0.0 && mf < 10.0) minFlowThreshold = mf;
    }
  }

  // ---- 3. TELEMETRY AGGREGATION (every 5s) ----
  // Gov node collects consumer totals for dashboard display only.
  // NO theft detection here — that's handled by consumer ESP + dashboard.
  if (Firebase.ready() && (millis() - telemetryMillis > 5000)) {
    telemetryMillis = millis();

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

  if (Firebase.ready() && (millis() - sendFlowPrevMillis > 1000)) {
    sendFlowPrevMillis = millis();
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/flowRate"), flowRate);
    Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/gov_node/lastSeen"));
  }

  if (Firebase.ready() && (millis() - sendDataPrevMillis > 5000)) {
    sendDataPrevMillis = millis();
    long tSum = 0;
    for (int i = 0; i < 20; i++) { tSum += analogRead(TURBIDITY_PIN); delayMicroseconds(50); }
    float tVolts = (tSum / 20.0) * (3.3 / 4095.0);
    
    long dSum = 0;
    for (int i = 0; i < 20; i++) { dSum += analogRead(TDS_PIN); delayMicroseconds(50); }
    float dVolts = (dSum / 20.0) * (3.3 / 4095.0);
    float tds = (133.42 * dVolts * dVolts * dVolts - 255.86 * dVolts * dVolts + 857.39 * dVolts);

    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/turbidityVoltage"), tVolts);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/tdsValue"), tds);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/tdsConnected"), (dVolts > 0.05));
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/turbidityConnected"), (tVolts > 0.05));
    Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/waterStatus"), (tVolts > 2.5) ? "CLEAR" : "DIRTY");
  }
}
