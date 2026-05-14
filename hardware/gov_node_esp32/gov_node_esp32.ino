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
unsigned long theftCheckMillis = 0;
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
float flowCalibration = 98.0; // F = 98 for 6mm ID pipe (1L = 5880 pulses)

// ========================= THEFT LOGIC =========================
String theftStatus = "NORMAL";
unsigned long theftAlertStartTime = 0;
bool theftFlaggedGlobal = false;

// Theft detection tuning
const float GOV_FLOW_ACTIVE_LPM = 0.5;
const float RAMESH_ZERO_LPM = 0.01; // Even 0.01 L/min is "Flowing" (Don't mark)
const unsigned long THEFT_PERSIST_MS = 5000;

// Valve-change grace period: suppress theft detection for 15s after any valve toggle
unsigned long lastValveChangeTime = 0;
bool prevRameshValveGov = true;

static float jsonToFloat(FirebaseJsonData &d) {
  // FirebaseJsonData::to<T>() is not a const member, so we take a non-const
  // reference.
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
  // RESTORED sensitivity: 500us debounce
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
  WiFi.setSleep(false); // Disable power save for stability
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
    Serial.printf("Sign-up Fail: %s\n",
                  config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  fbdo.setResponseSize(2048); // Increased for ESP32 stability
  fbdo.setBSSLBufferSize(2048, 1024);

  // ---- Data Recovery ----
  if (Firebase.ready()) {
    if (Firebase.RTDB.getFloat(&fbdo,
                               F("sensorData/gov_node/govSupplyLitres"))) {
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
  // ---- 0. CONNECTION WATCHDOG ----
  static unsigned long lastWifiCheck = 0;
  if (WiFi.status() != WL_CONNECTED && (millis() - lastWifiCheck > 2000)) {
    lastWifiCheck = millis();
    Serial.println("WiFi Lost. Reconnecting...");
    WiFi.reconnect();
  }

  // ---- 1. COMMAND SYNC ----
  if (Firebase.ready() && (millis() - lastCmdCheck > 1500)) {
    lastCmdCheck = millis();
    if (Firebase.RTDB.getJSON(&fbdo, F("commands"))) {
      FirebaseJson &j = fbdo.jsonObject();
      FirebaseJsonData d;
      if (j.get(d, F("resetAll")) && d.success && d.boolValue) {
        govSupplyLitres = 0;
        flowRate = 0;
        pulseCount = 0;
        theftStatus = "NORMAL";
        theftAlertStartTime = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/resetAll"), false);
        Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/theftStatus"),
                                "NORMAL");
      }
    }
  }

  // ---- 2. FLOW CALCULATION ----
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
      // Sticky Filter: Slower decay to prevent flickering to 0
      if (pc > 0) {
        flowRate = flowRate * 0.5 + raw * 0.5;
      } else {
        flowRate = flowRate * 0.8;
        if (flowRate < 0.05)
          flowRate = 0;
      }
    }
    float ppl = flowCalibration * 60.0;
    if (ppl > 0)
      govSupplyLitres += (float)pc / ppl;
    lastFlowCalc = millis();
  }

  // ---- 3. ADVANCED THEFT DETECTION (every 5s) ----
  if (Firebase.ready() && (millis() - theftCheckMillis > 5000)) {
    theftCheckMillis = millis();

    // PERSISTENT FETCH: Retain last known values if network fails
    float rameshFlow = 0, rameshTotal = 0, priyaTotal = 0;
    bool rTamper = false, rAccountFlagged = false;
    bool rValveUser = true, rValveGov = true;
    bool pValveUser = true, pValveGov = true;
    unsigned long rameshLastSeen = 0;

    if (Firebase.RTDB.getJSON(&fbdo, F("sensorData"))) {
      FirebaseJson &res = fbdo.jsonObject();
      FirebaseJsonData d;
      if (res.get(d, F("consumer_node/flowRate")))
        rameshFlow = jsonToFloat(d);
      if (res.get(d, F("consumer_node/totalLitres")))
        rameshTotal = jsonToFloat(d);
      if (res.get(d, F("consumer_node/tamperDetected")))
        rTamper = d.boolValue;
      if (res.get(d, F("consumer_node/lastSeen")))
        rameshLastSeen = (unsigned long)jsonToFloat(d);
      if (res.get(d, F("consumer_node_8266/totalLitres")))
        priyaTotal = jsonToFloat(d);
    }

    // NEW: Check if Admin has cleared the flag in Accounts
    if (Firebase.RTDB.getJSON(&fbdo, F("accounts/consumer_node"))) {
      FirebaseJson &res = fbdo.jsonObject();
      FirebaseJsonData d;
      if (res.get(d, F("theftFlagged")))
        rAccountFlagged = d.boolValue;
    }

    // Sync local status with cloud flag: If DB says not flagged, we reset local
    // status
    if (!rAccountFlagged && theftStatus == "THEFT FLAGGED") {
      theftStatus = "NORMAL";
      theftAlertStartTime = 0;
    }

    if (Firebase.RTDB.getJSON(&fbdo, F("valves"))) {
      FirebaseJson &res = fbdo.jsonObject();
      FirebaseJsonData d;
      if (res.get(d, F("consumer_node/user")))
        rValveUser = d.boolValue;
      if (res.get(d, F("consumer_node/gov")))
        rValveGov = d.boolValue;
      if (res.get(d, F("consumer_node_8266/user")))
        pValveUser = d.boolValue;
      if (res.get(d, F("consumer_node_8266/gov")))
        pValveGov = d.boolValue;
    }

    // Track valve state changes to suppress false theft detection
    if (rValveGov != prevRameshValveGov) {
      lastValveChangeTime = millis();
      prevRameshValveGov = rValveGov;
      Serial.printf("Valve state changed -> grace period started (15s)\n");
    }

    bool rameshOpen = (rValveUser && rValveGov);
    bool priyaOpen = (pValveUser && pValveGov);

    // Consider Ramesh offline if no heartbeat in 60s (avoid false theft when
    // node is down)
    bool rameshOnline = false;
    if (rameshLastSeen > 0) {
      rameshOnline = true;
    }

    // Aggregate Data
    float consumerTotalLitres = rameshTotal + priyaTotal;
    float flowDifference = govSupplyLitres - consumerTotalLitres;
    if (flowDifference < 0)
      flowDifference = 0; // Calibration drift protection

    static bool lastRTamper = false;
    if (rTamper && !lastRTamper) {
      logAlert("Ramesh", "TAMPER",
               "Meter displacement detected! Auto-blocking node.");
      Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node/gov"), false);
      Firebase.RTDB.setString(&fbdo, F("accounts/consumer_node/theftReason"),
                              "Meter Tampering (MPU Tilt)");
    }
    lastRTamper = rTamper;

    // THEFT DETECTION — only runs when:
    // 1. Grace period after valve change has expired (15 seconds)
    // 2. Ramesh's valve is OPEN (both gov + user)
    // 3. Gov flow is active (>0.1 L/min)
    // 4. Ramesh flow is essentially zero (<0.01) for 5 consecutive seconds
    // This prevents false theft when valve was just opened and Ramesh
    // hasn't reported flow yet (2s reporting delay + network latency).

    bool inGracePeriod = (millis() - lastValveChangeTime) < 15000;
    bool potentialTheft = false;

    if (!inGracePeriod && rameshOpen && flowRate > 0.1 && rameshFlow < 0.01) {
      potentialTheft = true;
    }

    if (potentialTheft) {
      if (theftAlertStartTime == 0) {
        theftAlertStartTime = millis();
        theftStatus = "PENDING_ALERT";
      } else if (millis() - theftAlertStartTime > THEFT_PERSIST_MS) {
        if (theftStatus != "THEFT FLAGGED") {
          theftStatus = "THEFT FLAGGED";
          String reason = "Gov flow detected but Ramesh flow is 0 (Persistent "
                          "5s). Bypass suspected.";
          logAlert("Ramesh", "THEFT", reason.c_str());

          FirebaseJson updates;
          updates.set("valves/consumer_node/gov", false);
          updates.set("accounts/consumer_node/theftFlagged", true);
          updates.set("accounts/consumer_node/theftReason", reason);
          Firebase.RTDB.updateNode(&fbdo, "/", &updates);
        }
      }
    } else {
      // RESET COUNTDOWN INSTANTLY if flow resumes or conditions not met
      if (theftAlertStartTime > 0) {
        Serial.println(F("Theft countdown ABORTED: Conditions cleared."));
      }
      theftAlertStartTime = 0;
      if (theftStatus == "PENDING_ALERT")
        theftStatus = "NORMAL";
    }

    // Batch Update Status (Telemetery)
    FirebaseJson statusUpdates;
    statusUpdates.set("sensorData/gov_node/theftStatus", theftStatus);
    statusUpdates.set("sensorData/gov_node/govSupplyLitres", govSupplyLitres);
    statusUpdates.set("sensorData/gov_node/consumerTotalLitres",
                      consumerTotalLitres);
    statusUpdates.set("sensorData/gov_node/flowDifference", flowDifference);
    Firebase.RTDB.updateNode(&fbdo, "/", &statusUpdates);
  }

  // ---- 4. DATA SYNC (Increased Frequency for responsiveness) ----
  if (Firebase.ready() && (millis() - sendFlowPrevMillis > 1000)) {
    sendFlowPrevMillis = millis();
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/flowRate"), flowRate);
    Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/gov_node/lastSeen"));
    Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/theftStatus"),
                            theftStatus);
  }

  // ---- 5. WATER QUALITY (every 10s) ----
  if (Firebase.ready() && (millis() - sendDataPrevMillis > 10000)) {
    sendDataPrevMillis = millis();

    // Faster averaging to avoid loop delays
    long tSum = 0;
    for (int i = 0; i < 10; i++) {
      tSum += analogRead(TURBIDITY_PIN);
      delayMicroseconds(100);
    }
    float tVolts = (tSum / 10.0) * (3.3 / 4095.0);

    long dSum = 0;
    for (int i = 0; i < 10; i++) {
      dSum += analogRead(TDS_PIN);
      delayMicroseconds(100);
    }
    float dVolts = (dSum / 10.0) * (3.3 / 4095.0);
    float tds = (133.42 * dVolts * dVolts * dVolts - 255.86 * dVolts * dVolts +
                 857.39 * dVolts) *
                0.5;

    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/turbidityVoltage"),
                           tVolts);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/tdsValue"), tds);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/tdsConnected"),
                          (tds > 1.0));
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/turbidityConnected"),
                          (tVolts > 0.1));
    Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/waterStatus"),
                            (tVolts > 3.0) ? "CLEAR" : "DIRTY");

    Serial.printf("Gov Flow:%.2f | Supply:%.2f | TDS:%.0f | Status:%s\n",
                  flowRate, govSupplyLitres, tds,
                  (tVolts > 3.0) ? "CLEAR" : "DIRTY");
  }
}
