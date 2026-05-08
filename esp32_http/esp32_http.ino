#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiManager.h>

// =========================
// SENSOR PINS & CONFIG
// =========================
#define TURBIDITY_PIN 34
#define TDS_PIN 35
float turbidityThreshold = 3.15;

// CHANGE THIS TO YOUR NODE.JS SERVER IP AND PORT
const char* serverName = "http://192.168.1.100:5000/api/sensor/data";

unsigned long sendDataPrevMillis = 0;

void setup() {
  Serial.begin(115200);
  
  WiFiManager wifiManager;
  Serial.println("Connecting to Wi-Fi...");
  if (!wifiManager.autoConnect("WaterQuality_AP")) {
    Serial.println("Failed to connect, restarting...");
    delay(3000);
    ESP.restart();
  }

  Serial.println();
  Serial.print("Connected with IP: ");
  Serial.println(WiFi.localIP());
  
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED && (millis() - sendDataPrevMillis > 5000 || sendDataPrevMillis == 0)) {
    sendDataPrevMillis = millis();
    
    // =========================
    // TURBIDITY SENSOR
    // =========================
    int turbidityValue = analogRead(TURBIDITY_PIN);
    float turbidityVoltage = turbidityValue * (3.3 / 4095.0);
    String waterStatus = (turbidityVoltage > turbidityThreshold) ? "CLEAR" : "DIRTY";

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
    // SEND HTTP POST REQUEST
    // =========================
    HTTPClient http;
    http.begin(serverName);
    http.addHeader("Content-Type", "application/json");

    String jsonPayload = "{\"tdsValue\":" + String(tdsValue) + 
                         ",\"turbidityVoltage\":" + String(turbidityVoltage) + 
                         ",\"waterStatus\":\"" + waterStatus + "\"}";

    int httpResponseCode = http.POST(jsonPayload);

    if (httpResponseCode > 0) {
      Serial.print("HTTP Response code: ");
      Serial.println(httpResponseCode);
      Serial.println("==> Successfully sent to Node.js!");
    } else {
      Serial.print("Error code: ");
      Serial.println(httpResponseCode);
    }
    http.end();

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
