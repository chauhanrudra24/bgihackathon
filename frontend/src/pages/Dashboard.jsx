import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ref, onValue, set, remove } from 'firebase/database';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, firestore } from '../firebase';

const isNodeOnline = (nodeData) => {
  if (!nodeData || !nodeData.lastSeen) return false;
  // 60s threshold + drift tolerance
  const diff = Math.abs(Date.now() - nodeData.lastSeen);
  return diff < 60000;
};

// =========================
// THEFT ALERT BANNER
// =========================
const TheftAlertBanner = ({ theftStatus, govSupply, consumerTotal, difference }) => {
  if (theftStatus === 'NORMAL' || !theftStatus) return null;

  const isAlert = theftStatus === 'ALERT';
  
  return (
    <div className={`theft-banner ${isAlert ? 'alert' : 'suspicious'}`} id="theft-alert-banner">
      <div className="theft-banner-icon">{isAlert ? '🚨' : '⚠️'}</div>
      <div className="theft-banner-content">
        <h3>{isAlert ? 'THEFT ALERT: Major Water Loss Detected!' : 'SUSPICIOUS: Minor Flow Discrepancy'}</h3>
        <p>
          Gov Supply: <strong>{govSupply?.toFixed(2) || 0} L</strong> |
          Consumer Total: <strong>{consumerTotal?.toFixed(2) || 0} L</strong> |
          Unaccounted: <strong>{difference?.toFixed(2) || 0} L</strong>
        </p>
      </div>
    </div>
  );
};

// =========================
// FLOW METER CARD
const FlowMeterCard = ({ flowRate, totalLitres, label }) => {
  return (
    <div className="card flow-card" id={`flow-card-${label}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h3>💧 {label}</h3>
        <span className="status" style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', background: 'var(--primary-light)', color: 'var(--primary)' }}>
          STABILIZED
        </span>
      </div>
      <div className="flow-meter-display">
        <div className="flow-gauge">
          <div className="flow-value-large">{(flowRate || 0).toFixed(1)}</div>
          <div className="flow-unit">L/min</div>
        </div>
        <div className="flow-total">
          <div className="flow-total-value">{(totalLitres || 0).toFixed(2)}</div>
          <div className="flow-total-label">Total Litres</div>
        </div>
      </div>
      {flowRate > 0 && (
        <div className="flow-active-indicator">
          <span className="flow-dot"></span> Water Flowing
        </div>
      )}
    </div>
  );
};

// =========================
// SENSOR NODE CARD (Gov Node)
// =========================
const NodeCard = ({ title, nodeData }) => {
  const online = isNodeOnline(nodeData);

  if (!nodeData || !online) {
    return (
      <div className="node-container">
        <h2>{title}</h2>
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div className="status offline" style={{ marginBottom: '1rem' }}>Disconnected</div>
          <h2 style={{ color: 'var(--warning)', margin: '1rem 0' }}>🔌 Node Offline</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '300px', margin: '0 auto' }}>
            Waiting for ESP to power on and connect to Wi-Fi...
          </p>
        </div>
      </div>
    );
  }

  const tdsConnected = nodeData.tdsConnected === true;
  const tds = tdsConnected ? (nodeData.tdsValue || 0) : 0;
  let tdsQuality = tdsConnected ? "GOOD" : "NOT CONNECTED";
  let tdsClass = tdsConnected ? "status" : "status offline";

  if (tdsConnected) {
    if (tds <= 50) tdsQuality = "EXCELLENT";
    else if (tds <= 150) tdsQuality = "IDEAL";
    else if (tds <= 300) tdsQuality = "GOOD";
    else if (tds <= 500) {
        tdsQuality = "FAIR";
        tdsClass = "status warning";
    } else {
        tdsQuality = "POOR";
        tdsClass = "status dirty";
    }
  }

  const turbConnected = nodeData.turbidityConnected === true;
  const turbVoltage = turbConnected ? (nodeData.turbidityVoltage || 0) : 0;
  const turbStatus = turbConnected ? (nodeData.waterStatus || "UNKNOWN") : "NOT CONNECTED";
  
  let turbClass = "status";
  if (!turbConnected) turbClass = "status offline";
  else if (nodeData.waterStatus === 'DIRTY') turbClass = "status dirty";

  let finalQuality = "ACCEPTABLE";
  let finalClass = "status";

  if (!turbConnected || !tdsConnected) {
    finalQuality = "SENSOR ERROR";
    finalClass = "status warning";
  } else if (turbStatus === 'NOT CONNECTED' || tdsQuality === 'NOT CONNECTED') {
    finalQuality = "SENSOR DISCONNECTED";
    finalClass = "status offline";
  } else if (nodeData.waterStatus === 'DIRTY') {
    finalQuality = "UNSAFE (DIRTY)";
    finalClass = "status dirty";
  } else {
    if (tds <= 150) finalQuality = "ULTRA-PURE";
    else if (tds <= 300) finalQuality = "GOOD QUALITY";
    else if (tds <= 500) {
        finalQuality = "MINERAL HEAVY";
        finalClass = "status warning";
    } else {
        finalQuality = "UNACCEPTABLE";
        finalClass = "status dirty";
    }
  }

  return (
    <div className="node-container">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem', gap: '10px' }}>
        <h2>{title}</h2>
        <span className={`status ${online ? '' : 'offline'}`}>
          {online ? '● ONLINE' : `🔌 OFFLINE (Seen ${nodeData.lastSeen ? new Date(nodeData.lastSeen).toLocaleTimeString() : 'Never'})`}
        </span>
      </div>
      
      <div className="nodes-grid">
        <div className="card">
            <h3>TDS Level</h3>
            <div className="value">
              {tdsConnected ? tds.toFixed(2) : "--"}
              <span className="unit">ppm</span>
            </div>
            <div className={tdsClass}>{tdsQuality}</div>
        </div>
        
        <div className="card">
            <h3>Turbidity</h3>
            <div className="value">
              {turbConnected ? turbVoltage.toFixed(2) : "--"}
              <span className="unit">V</span>
            </div>
            <div className={turbClass}>{turbStatus}</div>
        </div>

        <div className="card">
            <h3>Overall Quality</h3>
            <div className="value" style={{ fontSize: '1.5rem', margin: '0.75rem 0' }}>{finalQuality}</div>
            <div className={finalClass}>{(!turbConnected || !tdsConnected) ? "CHECK SENSORS" : "VERIFIED"}</div>
        </div>
      </div>

      {/* Flow Meter for Gov Node */}
      <div style={{ marginTop: '1.5rem' }}>
        <FlowMeterCard 
          flowRate={nodeData.flowRate} 
          totalLitres={nodeData.totalLitres} 
          label="Main Supply Flow"
        />
      </div>
    </div>
  );
};

// =========================
// CONSUMER VALVE + FLOW CARD
// =========================
const ConsumerCard = ({ title, valveState, onToggleValve, nodeData, nodeId, account, onBlockToggle }) => {
  const online = isNodeOnline(nodeData);
  const tamper = nodeData?.tamperDetected || false;
  const theftFlagged = account?.theftFlagged || false;
  const balance = account?.balance ?? 500;
  const blocked = account?.blocked || false;
  const emergencyActive = nodeData?.emergencyActive || false;
  const emergencyValue = Number(nodeData?.emergencyValue) || 0;
  const hasSensor = nodeId === 'consumer_node'; // Logic to distinguish Ramesh vs Priya

  const handleEmergencyTrigger = () => {
    if (window.confirm(`🆘 Grant emergency water access to ${title}?`)) {
      set(ref(db, `commands/${nodeId}/triggerEmergency`), true);
    }
  };

  return (
    <div className={`consumer-full-card ${tamper || theftFlagged ? 'tamper-active' : ''} ${emergencyActive ? 'emergency-mode' : ''}`} id={`consumer-card-${nodeId}`}>
      {/* Emergency Active Alert */}
      {emergencyActive && online && (
        <div className="tamper-alert" style={{ background: 'linear-gradient(135deg, #ef4444, #b91c1c)' }}>
          <span>🆘 EMERGENCY OVERRIDE ACTIVE</span> — Granting free water access ({hasSensor ? `${emergencyValue.toFixed(2)} L remaining` : `${Math.floor(emergencyValue)}s remaining`}).
        </div>
      )}
      {/* Tamper Alert */}
      {tamper && online && (
        <div className="tamper-alert">
          <span>🚨 TAMPER DETECTED</span> — Flow detected while valve is CLOSED or DEVICE SHAKING/REMOVAL detected. Possible bypass or theft attempt.
        </div>
      )}

      {/* Theft Flag Alert */}
      {theftFlagged && (
        <div className="tamper-alert" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}>
          <span>🕵️ THEFT FLAGGED</span> — Supply active but no consumer flow detected. Possible bypass.
        </div>
      )}

      {/* Zero Balance Alert */}
      {balance <= 0 && (
        <div className="tamper-alert" style={{ background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}>
          <span>💳 ZERO BALANCE</span> — Prepaid balance exhausted. Supply auto-blocked.
        </div>
      )}

      {/* Header */}
      <div className="consumer-card-header">
        <div>
          <h3>{title}</h3>
          <p className="consumer-status-text">
            {blocked || theftFlagged ? '🔒 BLOCKED' : (online ? (tamper ? 'TAMPER ALERT' : 'Active') : 'Offline')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span style={{ 
            padding: '0.25rem 0.75rem', borderRadius: '9999px', fontSize: '0.7rem', fontWeight: 700,
            background: balance > 100 ? 'var(--success-light)' : balance > 0 ? 'var(--warning-light)' : 'var(--danger-light)',
            color: balance > 100 ? 'var(--success)' : balance > 0 ? 'var(--warning)' : 'var(--danger)'
          }}>
            ₹{balance.toFixed(0)}
          </span>
          <span className={`status ${online ? (tamper || theftFlagged ? 'dirty' : '') : 'offline'}`}>
            {online ? (
              theftFlagged ? (
                <span className="status-label theft-flagged">🚩 THEFT FLAGGED</span>
              ) : tamper ? (
                <span className="status-label tamper-alert">⚠ TAMPER ALERT</span>
              ) : (
                <span className="status-label online">● ONLINE</span>
              )
            ) : (
              `OFFLINE (${nodeData?.lastSeen ? new Date(nodeData.lastSeen).toLocaleTimeString() : 'Never'})`
            )}
          </span>
        </div>
      </div>

      {/* Flow Data — ALWAYS visible regardless of theft/emergency */}
      <div className="consumer-flow-row">
        {/* Emergency info shown as additional item, not replacement */}
        {emergencyActive && (
          <div className="consumer-flow-item" style={{ background: 'rgba(239, 68, 68, 0.1)', borderRadius: 'var(--radius-md)', padding: '0.5rem' }}>
            <span className="consumer-flow-label" style={{ color: 'var(--danger)', fontWeight: 700 }}>🆘 SOS Remaining</span>
            <span className="consumer-flow-value" style={{ color: 'var(--danger)' }}>
              {hasSensor ? `${emergencyValue.toFixed(2)}` : `${Math.floor(emergencyValue)}`}
              <small>{hasSensor ? 'L' : 'sec'}</small>
            </span>
          </div>
        )}
        <div className="consumer-flow-item">
          <span className="consumer-flow-label">Flow Rate</span>
          <span className="consumer-flow-value">{(nodeData?.flowRate || 0).toFixed(2)} <small>L/min</small></span>
        </div>
        <div className="consumer-flow-item">
          <span className="consumer-flow-label">Total Usage</span>
          <span className="consumer-flow-value">{nodeData?.totalLitres !== undefined ? nodeData.totalLitres.toFixed(3) : 'N/A'} <small>L</small></span>
        </div>
        <div className="consumer-flow-item">
          <span className="consumer-flow-label">Valve</span>
          <span className={`consumer-flow-value ${valveState ? 'valve-open' : 'valve-closed'}`}>
            {valveState ? '🟢 OPEN' : '🔴 CLOSED'}
          </span>
        </div>
      </div>

      {/* Valve Control + Block Toggle */}
      <div className="consumer-card-footer" style={{ gap: '0.5rem' }}>
        {(theftFlagged || blocked) && (
          <button 
            onClick={onBlockToggle}
            className="unblock-btn"
            style={{ marginRight: 'auto' }}
          >
            ✅ Verify & Unblock
          </button>
        )}
        {!theftFlagged && !blocked && (
          <button
            onClick={onBlockToggle}
            style={{ marginRight: 'auto', background: 'var(--danger-light)', color: 'var(--danger)', border: 'none', padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer', fontSize: '0.8rem' }}
          >
            🚫 Block User
          </button>
        )}
        {/* SOS Trigger Removed - Use Physical Button */}
        <button 
          disabled={!online || (theftFlagged || blocked) && !emergencyActive}
          onClick={onToggleValve} 
          className={`valve-btn ${valveState ? 'open' : 'closed'}`}
        >
          {valveState ? "CLOSE VALVE" : "OPEN VALVE"}
        </button>
      </div>
    </div>
  );
};

// =========================
// SETTINGS VIEW
// =========================
const SettingsView = () => {
  const [settings, setSettings] = useState(null);
  const [localPrice, setLocalPrice] = useState(0.5);
  const [localGovCal, setLocalGovCal] = useState(96.0);
  const [localConsCal, setLocalConsCal] = useState(96.0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Listen for settings changes in Firebase
  useEffect(() => {
    const settingsRef = ref(db, 'settings');
    const unsubscribe = onValue(settingsRef, (snapshot) => {
      const s = snapshot.val();
      if (s) {
        setSettings(s);
        setLocalPrice(s.pricePerLiter ?? 0.5);
        setLocalGovCal(s.govCalibration ?? 96.0);
        setLocalConsCal(s.consumerCalibration ?? 96.0);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await set(ref(db, 'settings'), {
        pricePerLiter: parseFloat(localPrice),
        govCalibration: parseFloat(localGovCal),
        consumerCalibration: parseFloat(localConsCal),
        updatedAt: Date.now()
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert("❌ Failed to save settings: " + err.message);
    }
    setSaving(false);
  };

  return (
    <div className="main-content">
        <div className="card settings-card">
            <h2>⚙️ System Configuration</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Configure global pricing and calibrate IoT flow sensors remotely.</p>
            
            {/* Current saved values indicator */}
            {settings && (
              <div style={{ background: 'var(--primary-light)', padding: '0.75rem 1.25rem', borderRadius: 'var(--radius-md)', marginBottom: '1.5rem', fontSize: '0.85rem', color: 'var(--primary)' }}>
                <strong>🔥 Live from Firebase:</strong> Rate: ₹{settings.pricePerLiter}/L | Gov Cal: {settings.govCalibration} | Consumer Cal: {settings.consumerCalibration}
                {settings.updatedAt && <span style={{ opacity: 0.7 }}> | Last saved: {new Date(settings.updatedAt).toLocaleString()}</span>}
              </div>
            )}

            <div className="settings-grid">
              <div className="input-group">
                <label>💰 Water Price (₹ per Liter)</label>
                <input type="number" step="0.01" value={localPrice} onChange={(e) => setLocalPrice(e.target.value)} />
                <small>Used for billing calculations across the network. Consumer dashboards update instantly.</small>
              </div>

              <div className="input-group">
                <label>🏗️ Gov Node Calibration</label>
                <input type="number" step="0.1" value={localGovCal} onChange={(e) => setLocalGovCal(e.target.value)} />
                <small>Standard: 96.0. Calibrated for 6mm ID pipe. System now applies 0.15α smoothing.</small>
              </div>
              
              <div className="input-group">
                <label>🏠 Consumer Node Calibration</label>
                <input type="number" step="0.1" value={localConsCal} onChange={(e) => setLocalConsCal(e.target.value)} />
                <small>Standard: 96.0. System automatically adjusts pulse-to-liter integration based on this value.</small>
              </div>
            </div>

            {/* Quick price presets */}
            <div style={{ marginTop: '1.5rem' }}>
              <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Quick Rate Presets:</p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {[0.25, 0.50, 1.00, 2.00, 5.00].map(r => (
                  <button key={r} onClick={() => setLocalPrice(r)}
                    style={{ 
                      padding: '0.4rem 0.8rem', 
                      border: parseFloat(localPrice) === r ? '2px solid var(--primary)' : '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-md)', 
                      background: parseFloat(localPrice) === r ? 'var(--primary-light)' : 'white',
                      fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem'
                    }}>
                    ₹{r}/L
                  </button>
                ))}
              </div>
            </div>

            <button disabled={saving} onClick={handleSave} className="submit-btn" style={{ marginTop: '2rem', maxWidth: '250px' }}>
              {saving ? 'Saving to Firebase...' : saved ? '✅ Saved Successfully!' : '💾 Save Settings'}
            </button>
        </div>
    </div>
  );
};

// =========================
// MAIN DASHBOARD
// =========================
const CONSUMER_NODES = [
  { nodeId: 'consumer_node', name: 'Ramesh Kumar', location: 'Umaria, near BGI', hasSensor: true },
  { nodeId: 'consumer_node_8266', name: 'Priya Patel', location: 'Pigdamber, near BGI', hasSensor: false },
];

const Dashboard = () => {
  const [data, setData] = useState(null);
  const [valves, setValves] = useState({});
  const [accounts, setAccounts] = useState({});
  const [commands, setCommands] = useState({});
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState('dashboard');
  const navigate = useNavigate();

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if (user.role !== 'admin') {
      navigate('/');
      return;
    }

    const sensorRef = ref(db, 'sensorData');
    const valvesRef = ref(db, 'valves');
    const accountsRef = ref(db, 'accounts');
    const commandsRef = ref(db, 'commands');
    
    const unsubscribeSensors = onValue(sensorRef, (snapshot) => {
      const newData = snapshot.val();
      if (newData) {
        setData(newData);
        setErrorMsg('');
      } else {
        setErrorMsg('Connected to Firebase, but sensorData is empty.');
      }
    }, (error) => {
      console.error("Firebase Error: ", error);
      setErrorMsg('Firebase Error: ' + error.message);
    });

    const unsubscribeValves = onValue(valvesRef, (snapshot) => {
      setValves(snapshot.val() || {});
    });

    const unsubscribeAccounts = onValue(accountsRef, (snapshot) => {
      setAccounts(snapshot.val() || {});
    });

    const unsubscribeCommands = onValue(commandsRef, (snapshot) => {
      setCommands(snapshot.val() || {});
    });

    return () => {
      unsubscribeSensors();
      unsubscribeValves();
      unsubscribeAccounts();
      unsubscribeCommands();
    };
  }, [navigate]);


  // ===== AUTO THEFT DETECTION =====
  // If gov supply is active (flowRate > 0) but a consumer's valve is open and their flow is 0, flag as suspicious
  useEffect(() => {
    if (!data || commands.resetAll) return; // SKIP THEFT CHECK DURING RESET
    const govNode = data.gov_node;
    const govOnline = isNodeOnline(govNode);
    // If gov supply is active (>2L/min), consumer is online, valve is open, but consumer flow is zero → flag
    if (govOnline && govNode.flowRate > 2.0) {
      CONSUMER_NODES.forEach(({ nodeId, hasSensor }) => {
        if (!hasSensor) return; // Skip theft check for nodes without flow sensors
        const consumerData = data[nodeId];
        const consumerOnline = isNodeOnline(consumerData);
        const valve = valves[nodeId];
        const valveOpen = valve?.gov !== false && valve?.user !== false;
        const consumerFlow = consumerData?.flowRate ?? 0;
        const account = accounts[nodeId] || {};

        if (consumerOnline && valveOpen && consumerFlow === 0 && !account.theftFlagged) {
          set(ref(db, `accounts/${nodeId}/theftFlagged`), true);
          set(ref(db, `accounts/${nodeId}/theftReason`), 'Main supply active (>2L/min) but no consumer flow detected');
          set(ref(db, `accounts/${nodeId}/theftTime`), Date.now());
          // Auto-block the consumer valve
          set(ref(db, `valves/${nodeId}/gov`), false);
        }
      });
    }
  }, [data, valves, accounts]);

  // ===== AUTO BALANCE CHECK =====
  // If balance <= 0, auto-block supply
  useEffect(() => {
    CONSUMER_NODES.forEach(({ nodeId }) => {
      const account = accounts[nodeId];
      if (account && account.balance !== undefined && account.balance <= 0 && !account.blocked) {
        set(ref(db, `accounts/${nodeId}/blocked`), true);
        set(ref(db, `valves/${nodeId}/gov`), false);
      }
    });
  }, [accounts]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/');
  };

  const handleResetAllData = async () => {
    if (!data || !data.gov_node) {
      alert("⚠️ Cannot reset: No live connection to sensor data.");
      return;
    }

    if (!window.confirm("⚠️ Are you sure you want to RESET ALL DATA? This will set all total litres to zero across all nodes and start fresh.")) {
      return;
    }

    const currentGovNode = data.gov_node;
    const currentTheftStatus = currentGovNode.theftStatus || 'NORMAL';

    try {
      // 0. Store current session as "static data" in Firestore History before clearing
      const historyData = {
        timestamp: serverTimestamp(),
        totalGovSupply: currentGovNode.govSupplyLitres || 0,
        totalConsumerUsage: currentGovNode.consumerTotalLitres || 0,
        unaccountedLoss: currentGovNode.flowDifference || 0,
        theftStatus: currentTheftStatus,
        nodes: CONSUMER_NODES.map(node => ({
          nodeId: node.nodeId,
          name: node.name,
          totalUsage: data[node.nodeId]?.totalLitres || 0,
          balanceAtReset: accounts[node.nodeId]?.balance || 500
        }))
      };
      
      try {
        await addDoc(collection(firestore, "system_history"), historyData);
        console.log("Session data archived to Firestore.");
      } catch (fsErr) {
        console.warn("Firestore archive failed, but continuing with reset:", fsErr);
      }

      // 1. Build ALL reset updates atomically (including reset commands)
      const updates = {};
      updates['commands/resetAll'] = true;
      updates['commands/consumer_node/reset'] = true;
      updates['commands/consumer_node_8266/reset'] = true;
      updates['sensorData/gov_node/totalLitres'] = 0;
      updates['sensorData/gov_node/flowRate'] = 0;
      updates['sensorData/gov_node/govSupplyLitres'] = 0;
      updates['sensorData/gov_node/consumerTotalLitres'] = 0;
      updates['sensorData/gov_node/flowDifference'] = 0;
      updates['sensorData/gov_node/theftStatus'] = 'NORMAL';
      
      updates['sensorData/consumer_node/totalLitres'] = 0;
      updates['sensorData/consumer_node/flowRate'] = 0;
      updates['sensorData/consumer_node/emergencyActive'] = false;
      updates['sensorData/consumer_node/emergencyValue'] = 0;
      updates['sensorData/consumer_node/tamperDetected'] = false;
      
      updates['sensorData/consumer_node_8266/totalLitres'] = 0;
      updates['sensorData/consumer_node_8266/flowRate'] = 0;
      updates['sensorData/consumer_node_8266/emergencyActive'] = false;
      updates['sensorData/consumer_node_8266/emergencyValue'] = 0;
      updates['sensorData/consumer_node_8266/tamperDetected'] = false;

      // 3. Reset Accounts (Balance to 500) and Valves (Unblock everyone)
      for (const node of CONSUMER_NODES) {
        const { nodeId } = node;
        updates[`accounts/${nodeId}/balance`] = 500;
        updates[`accounts/${nodeId}/blocked`] = false;
        updates[`accounts/${nodeId}/theftFlagged`] = false;
        updates[`accounts/${nodeId}/theftReason`] = null;
        updates[`accounts/${nodeId}/theftTime`] = null;
        updates[`valves/${nodeId}/gov`] = true;
        updates[`valves/${nodeId}/user`] = true;
        updates[`commands/${nodeId}/triggerEmergency`] = false;
      }

      // Perform all updates in one go (more efficient)
      // Note: In Firebase modular SDK, you'd use 'update' but here we can just set them
      // To keep it simple and consistent with your style, I'll keep individual sets but as a promise array
      await Promise.all(Object.entries(updates).map(([path, val]) => set(ref(db, path), val)));

      // 4. Turn off reset flags after 5 seconds to let hardware catch up
      setTimeout(() => {
        const clearCommands = {};
        clearCommands['commands/consumer_node/reset'] = false;
        clearCommands['commands/consumer_node_8266/reset'] = false;
        clearCommands['commands/resetAll'] = false;
        update(ref(db), clearCommands);
      }, 5000);

      alert("✅ Reset command sent. System starting fresh!");
    } catch (err) {
      console.error("Reset failed:", err);
      alert("❌ Reset failed: " + err.message);
    }
  };

  const handleBlockToggle = (nodeId) => {
    const account = accounts[nodeId] || {};
    if (account.theftFlagged || account.blocked) {
      // Unblock: clear flags and re-open valve
      set(ref(db, `accounts/${nodeId}/theftFlagged`), false);
      set(ref(db, `accounts/${nodeId}/blocked`), false);
      set(ref(db, `accounts/${nodeId}/theftReason`), null);
      set(ref(db, `accounts/${nodeId}/theftTime`), null);
      set(ref(db, `valves/${nodeId}/gov`), true);
    } else {
      // Block user manually
      set(ref(db, `accounts/${nodeId}/blocked`), true);
      set(ref(db, `valves/${nodeId}/gov`), false);
    }
  };

  if (errorMsg) return <div className="dashboard"><h2>{errorMsg}</h2><button onClick={handleLogout} className="logout-btn">Logout</button></div>;
  if (!data) return <div className="dashboard"><h2>Connecting to Jal Board Network...</h2></div>;

  const govNode = data.gov_node || {};
  const theftStatus = govNode.theftStatus || 'NORMAL';

  // Gather flagged consumers for the theft list
  const flaggedConsumers = CONSUMER_NODES.filter(({ nodeId }) => {
    const acct = accounts[nodeId] || {};
    return acct.theftFlagged || acct.blocked;
  });

  const renderDashboard = () => (
    <div className="main-content">
      {/* Government Node - Water Quality + Flow */}
      <NodeCard 
        title="🏛️ Rau Pumping Station (BGI Indore Area)" 
        nodeData={govNode} 
      />

      {/* Supply vs Consumption Summary */}
      <div className="node-container" style={{ marginTop: '2rem' }}>
        <h2>📊 Network Efficiency</h2>
        <div className="nodes-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div className="card stat-card supply">
            <h3>Total Supply</h3>
            <div className="value">{(govNode.govSupplyLitres || 0).toFixed(1)}<span className="unit">L</span></div>
            <div className="status">FROM PLANT</div>
          </div>
          <div className="card stat-card consumption">
            <h3>Total Consumed</h3>
            <div className="value">{(govNode.consumerTotalLitres || 0).toFixed(1)}<span className="unit">L</span></div>
            <div className="status">BY HOMES</div>
          </div>
          <div className={`card stat-card ${theftStatus === 'ALERT' ? 'loss-alert' : theftStatus === 'SUSPICIOUS' ? 'loss-warn' : 'loss-ok'}`}>
            <h3>Unaccounted</h3>
            <div className="value">{(govNode.flowDifference || 0).toFixed(1)}<span className="unit">L</span></div>
            <div className={`status ${theftStatus === 'ALERT' ? 'dirty' : theftStatus === 'SUSPICIOUS' ? 'warning' : ''}`}>
              {theftStatus}
            </div>
          </div>
        </div>
      </div>

      {/* Theft / Suspicious Activity List */}
      {flaggedConsumers.length > 0 && (
        <div className="theft-list-container">
          <h2>🕵️ Theft / Suspicious Activity</h2>
          {flaggedConsumers.map(({ nodeId, name, location }) => {
            const acct = accounts[nodeId] || {};
            return (
              <div className="theft-item" key={nodeId}>
                <div className="theft-item-info">
                  <h4>🚨 {name} ({location})</h4>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {acct.theftFlagged 
                      ? (acct.theftReason || 'Suspicious flow pattern detected')
                      : (acct.balance <= 0 ? 'Zero balance — supply auto-blocked' : 'Manually blocked by admin')}
                  </p>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    Balance: ₹{(acct.balance ?? 500).toFixed(0)} | Node: <code>{nodeId}</code>
                  </p>
                </div>
                <button className="unblock-btn" onClick={() => handleBlockToggle(nodeId)}>
                  ✅ Verify & Unblock
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Consumer Control Section */}
      <div className="node-container" style={{ marginTop: '2.5rem' }}>
        <h2>🏠 Smart Meter Management</h2>
        <div className="consumer-grid">
          {CONSUMER_NODES.map(({ nodeId, name, location }) => (
            <ConsumerCard
              key={nodeId}
              title={`${name} (${location})`}
              nodeId={nodeId}
              valveState={valves[nodeId]?.gov ?? true}
              nodeData={data[nodeId]}
              account={accounts[nodeId] || { balance: 500 }}
              onToggleValve={() => set(ref(db, `valves/${nodeId}/gov`), !(valves[nodeId]?.gov ?? true))}
              onBlockToggle={() => handleBlockToggle(nodeId)}
            />
          ))}
        </div>
      </div>
    </div>
  );

  const renderAnalytics = () => (
    <div className="main-content">
      <div className="card">
        <h2>📡 Live Network Feed</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Real-time heartbeat monitoring for all network nodes.</p>
        
        <div className="theft-list-container" style={{ background: 'var(--bg-color)', padding: '1rem' }}>
          {/* Main Gov Node */}
          <div className="theft-item" style={{ borderLeft: '4px solid var(--primary)' }}>
            <div className="theft-item-info">
              <h4>🏢 Rau Pumping Station</h4>
              <p style={{ fontSize: '0.8rem' }}>Status: {isNodeOnline(govNode) ? '🟢 Online' : '🔴 Offline'}</p>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Last Seen: {govNode.lastSeen ? new Date(govNode.lastSeen).toLocaleTimeString() : 'Never'}
            </div>
          </div>

          {/* Consumer Nodes */}
          {CONSUMER_NODES.map(({ nodeId, name }) => {
            const nodeData = data[nodeId];
            const online = isNodeOnline(nodeData);
            return (
              <div className="theft-item" key={nodeId} style={{ borderLeft: `4px solid ${online ? 'var(--success)' : 'var(--danger)'}` }}>
                <div className="theft-item-info">
                  <h4>🏠 {name}</h4>
                  <p style={{ fontSize: '0.8rem' }}>Status: {online ? '🟢 Online' : '🔴 Offline'}</p>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Last Seen: {nodeData?.lastSeen ? new Date(nodeData.lastSeen).toLocaleTimeString() : 'Never'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderConsumers = () => (
    <div className="main-content">
        <h2>👥 Registered Consumers</h2>
        <div className="card">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                        <th style={{ padding: '1rem' }}>Name</th>
                        <th>Address</th>
                        <th>Node ID</th>
                        <th>Balance</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    {CONSUMER_NODES.map(({ nodeId, name, location }) => {
                      const acct = accounts[nodeId] || { balance: 500 };
                      const flagged = acct.theftFlagged || acct.blocked;
                      return (
                        <tr key={nodeId} style={{ borderBottom: '1px solid var(--border-color)' }}>
                          <td style={{ padding: '1rem' }}>{name}</td>
                          <td>{location}</td>
                          <td><code>{nodeId}</code></td>
                          <td>
                            <span style={{ fontWeight: 700, color: acct.balance > 100 ? 'var(--success)' : acct.balance > 0 ? 'var(--warning)' : 'var(--danger)' }}>
                              ₹{(acct.balance ?? 500).toFixed(0)}
                            </span>
                          </td>
                          <td>
                            <span className={`status ${flagged ? 'dirty' : ''}`}>
                              {flagged ? '🔒 Blocked' : 'Active'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
            </table>
        </div>
    </div>
  );

  return (
    <div className="gov-dashboard-layout">
      {/* Sidebar for Laptop */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div style={{ fontSize: '1.5rem' }}>💧</div>
          <h2>Jal Board</h2>
        </div>
        
        <nav className="sidebar-nav">
          <div className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>📊 Dashboard</div>
          <div className={`nav-item ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>📈 Analytics</div>
          <div className={`nav-item ${activeTab === 'consumers' ? 'active' : ''}`} onClick={() => setActiveTab('consumers')}>👥 Consumers</div>
          <div className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>⚙️ Settings</div>
        </nav>

        <div className="sidebar-footer">
          <div className="nav-item" onClick={handleLogout}>🚪 Logout</div>
        </div>
      </aside>

      <main className="main-content-area">
        <div className="dashboard">
          <div className="header-flex">
              <h1>🏛️ Government Control Center</h1>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <button onClick={handleResetAllData} className="reset-btn">🔄 Reset All Data</button>
                <div className="status" style={{ background: 'var(--primary-light)', color: 'var(--primary)' }}>ADMIN ACCESS</div>
              </div>
          </div>
          
          {/* Theft Alert Banner */}
          <TheftAlertBanner 
            theftStatus={theftStatus}
            govSupply={govNode.govSupplyLitres}
            consumerTotal={govNode.consumerTotalLitres}
            difference={govNode.flowDifference}
          />

          {activeTab === 'dashboard' && renderDashboard()}
          {activeTab === 'analytics' && renderAnalytics()}
          {activeTab === 'consumers' && renderConsumers()}
          {activeTab === 'settings' && <SettingsView />}
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
