#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"
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
unsigned long theftCheckMillis   = 0;
unsigned long lastCmdCheck       = 0;

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
float govSupplyLitres = 0.0;     // Total litres passed through main supply
unsigned long lastFlowCalc = 0;
float flowCalibration = 98.0; // F = 98 for 6mm ID pipe (1L = 5880 pulses)

// ========================= THEFT LOGIC =========================
String theftStatus = "NORMAL";
unsigned long theftAlertStartTime = 0;
bool theftFlaggedGlobal = false;

void IRAM_ATTR flowPulseISR() {
  static unsigned long lastPulse = 0;
  unsigned long now = micros();
  // RESTORED sensitivity: 500us debounce
  if (now - lastPulse > 500) {
    pulseCount++;
    lastPulse = now;
  }
}

void logAlert(const char* node, const char* type, const char* msg) {
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
  wm.setAPCallback([](WiFiManager *wm) {
    blinker.attach(0.2, blink);
  });

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
  
  fbdo.setResponseSize(2048); // Increased for ESP32 stability
  fbdo.setBSSLBufferSize(2048, 1024); 

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
        govSupplyLitres = 0; flowRate = 0; pulseCount = 0;
        theftStatus = "NORMAL"; theftAlertStartTime = 0;
        Firebase.RTDB.setBool(&fbdo, F("commands/resetAll"), false);
        Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/theftStatus"), "NORMAL");
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
      flowRate = (pc == 0) ? flowRate * 0.7 : (flowRate * 0.7 + raw * 0.3);
      if (flowRate < 0.05) flowRate = 0;
    }
    float ppl = flowCalibration * 60.0;
    if (ppl > 0) govSupplyLitres += (float)pc / ppl;
    lastFlowCalc = millis();
  }

  // ---- 3. ADVANCED THEFT DETECTION (every 5s) ----
  if (Firebase.ready() && (millis() - theftCheckMillis > 5000)) {
    theftCheckMillis = millis();
    
    // Fetch Ramesh data
    float rameshFlow = 0.0;
    float rameshTotal = 0.0;
    bool rTamper = false;
    bool rValveUser = true;
    bool rValveGov = true;
    
    if (Firebase.RTDB.getJSON(&fbdo, F("sensorData/consumer_node"))) {
      FirebaseJson &res = fbdo.jsonObject();
      FirebaseJsonData d;
      if (res.get(d, F("flowRate"))) rameshFlow = d.floatValue;
      if (res.get(d, F("totalLitres"))) rameshTotal = d.floatValue;
      if (res.get(d, F("tamperDetected"))) rTamper = d.boolValue;
    }
    if (Firebase.RTDB.getJSON(&fbdo, F("valves/consumer_node"))) {
      FirebaseJson &res = fbdo.jsonObject();
      FirebaseJsonData d;
      if (res.get(d, F("user"))) rValveUser = d.boolValue;
      if (res.get(d, F("gov"))) rValveGov = d.boolValue;
    }

    // Fetch Priya data
    float priyaTotal = 0.0;
    bool pValveUser = true;
    bool pValveGov = true;
    if (Firebase.RTDB.getJSON(&fbdo, F("sensorData/consumer_node_8266"))) {
      FirebaseJson &res = fbdo.jsonObject();
      FirebaseJsonData d;
      if (res.get(d, F("totalLitres"))) priyaTotal = d.floatValue;
    }
    if (Firebase.RTDB.getJSON(&fbdo, F("valves/consumer_node_8266"))) {
      FirebaseJson &res = fbdo.jsonObject();
      FirebaseJsonData d;
      if (res.get(d, F("user"))) pValveUser = d.boolValue;
      if (res.get(d, F("gov"))) pValveGov = d.boolValue;
    }

    bool rameshOpen = (rValveUser && rValveGov);
    bool priyaOpen = (pValveUser && pValveGov);
    
    // Aggregate Data
    float consumerTotalLitres = rameshTotal + priyaTotal;
    float flowDifference = govSupplyLitres - consumerTotalLitres;
    if (flowDifference < 0) flowDifference = 0; // Calibration drift protection
    
    static bool lastRTamper = false;
    if (rTamper && !lastRTamper) {
      logAlert("Ramesh", "TAMPER", "Meter displacement detected! Auto-blocking node.");
      Firebase.RTDB.setBool(&fbdo, F("valves/consumer_node/gov"), false);
      Firebase.RTDB.setString(&fbdo, F("accounts/consumer_node/theftReason"), "Meter Tampering (MPU Tilt)");
    }
    lastRTamper = rTamper;

    // IMPROVED RULE: 
    // Theft is flagged IF:
    // 1. Flow > 0.25 (Main supply active)
    // 2. AND BOTH valves are closed (Significant Leak/Bypass)
    // 3. OR Ramesh's valve is open but rameshFlow is ~0 (Bypass at Ramesh's node)
    // 4. AND Priya's valve is closed (To ensure flow isn't just going to Priya)

    bool potentialTheft = false;
    if (flowRate > 0.25) {
      if (!rameshOpen && !priyaOpen) {
        // Both closed but flow detected = Major Bypass/Leak
        potentialTheft = true;
      } else if (rameshOpen && !priyaOpen && rameshFlow < 0.05) {
        // Ramesh open, Priya closed, but Ramesh reports no flow = Bypass at Ramesh
        potentialTheft = true;
      }
    }

    if (potentialTheft) {
      if (theftAlertStartTime == 0) {
        theftAlertStartTime = millis();
        theftStatus = "PENDING_ALERT";
      } else if (millis() - theftAlertStartTime > 10000) { // Increased to 10s for stability
        if (theftStatus != "THEFT FLAGGED") {
          theftStatus = "THEFT FLAGGED";
          logAlert("System", "THEFT", "Main supply bypass suspected (Flow mismatch)");
          
          FirebaseJson updates;
          // Block Ramesh by default if theft is flagged
          updates.set("valves/consumer_node/gov", false);
          updates.set("accounts/consumer_node/theftFlagged", true);
          updates.set("accounts/consumer_node/theftReason", "Main supply bypass suspected (Flow mismatch)");
          Firebase.RTDB.updateNode(&fbdo, "/", &updates);
        }
      }
    } else {
      theftAlertStartTime = 0;
      if (theftStatus != "THEFT FLAGGED") theftStatus = "NORMAL";
    }
    
    // Batch Update Status
    FirebaseJson statusUpdates;
    statusUpdates.set("sensorData/gov_node/theftStatus", theftStatus);
    statusUpdates.set("sensorData/gov_node/govSupplyLitres", govSupplyLitres);
    statusUpdates.set("sensorData/gov_node/consumerTotalLitres", consumerTotalLitres);
    statusUpdates.set("sensorData/gov_node/flowDifference", flowDifference);
    Firebase.RTDB.updateNode(&fbdo, "/", &statusUpdates);
  }

  // ---- 4. DATA SYNC ----
  if (Firebase.ready() && (millis() - sendFlowPrevMillis > 2000)) {
    sendFlowPrevMillis = millis();
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/flowRate"), flowRate);
    Firebase.RTDB.setTimestamp(&fbdo, F("sensorData/gov_node/lastSeen"));
  }

  // ---- 5. WATER QUALITY (every 10s) ----
  if (Firebase.ready() && (millis() - sendDataPrevMillis > 10000)) {
    sendDataPrevMillis = millis();
    
    // Faster averaging to avoid loop delays
    long tSum = 0; for(int i=0;i<10;i++){ tSum += analogRead(TURBIDITY_PIN); delayMicroseconds(100); }
    float tVolts = (tSum / 10.0) * (3.3 / 4095.0);
    
    long dSum = 0; for(int i=0;i<10;i++){ dSum += analogRead(TDS_PIN); delayMicroseconds(100); }
    float dVolts = (dSum / 10.0) * (3.3 / 4095.0);
    float tds = (133.42*dVolts*dVolts*dVolts - 255.86*dVolts*dVolts + 857.39*dVolts) * 0.5;

    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/turbidityVoltage"), tVolts);
    Firebase.RTDB.setFloat(&fbdo, F("sensorData/gov_node/tdsValue"), tds);
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/tdsConnected"), (tds > 1.0));
    Firebase.RTDB.setBool(&fbdo, F("sensorData/gov_node/turbidityConnected"), (tVolts > 0.1));
    Firebase.RTDB.setString(&fbdo, F("sensorData/gov_node/waterStatus"), (tVolts > 3.0) ? "CLEAR" : "DIRTY");
    
    Serial.printf("Gov Flow:%.2f | Supply:%.2f | TDS:%.0f | Status:%s\n", 
      flowRate, govSupplyLitres, tds, (tVolts > 3.0) ? "CLEAR" : "DIRTY");
  }
}
