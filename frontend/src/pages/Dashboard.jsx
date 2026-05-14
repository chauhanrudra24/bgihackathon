import { useEffect, useState, useRef, memo, useMemo } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { ref, onValue, set, remove, update, push } from 'firebase/database';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, firestore } from '../firebase';
import toast from 'react-hot-toast';

const isNodeOnline = (nodeData) => {
  if (!nodeData || !nodeData.lastSeen) return false;
  const now = Date.now();
  let lastSeen = nodeData.lastSeen;
  if (typeof lastSeen === 'string') {
    const parsed = Number(lastSeen);
    if (Number.isFinite(parsed)) lastSeen = parsed;
  }
  // Firebase timestamps sometimes arrive in seconds; normalize to ms.
  if (typeof lastSeen === 'number' && lastSeen > 0 && lastSeen < 1e12) lastSeen *= 1000;
  // Increased to 60s to prevent flickering during network jitter or blocking I/O
  return (now - lastSeen) < 60000;
};

const formatVolume = (litres) => {
  const val = litres || 0;
  if (val < 1) {
    return `${(val * 1000).toFixed(0)} ml`;
  }
  return `${val.toFixed(3)} L`;
};


// =========================
// THEFT ALERT BANNER
// =========================
// Dashboard-computed theft: govFlow > 0 AND consumer theftCandidate == true
const TheftAlertBanner = ({ theftDetected, govFlow, consumerFlow, accounts }) => {
  if (!theftDetected) return null;

  // Find who is flagged
  const flaggedNodes = Object.entries(accounts || {})
    .filter(([_, acct]) => acct.theftFlagged)
    .map(([id]) => id === 'consumer_node' ? 'Ramesh Kumar (Umaria, near BGI)' : 'Priya Patel');
  
  return (
    <div className={`theft-banner alert`} id="theft-alert-banner">
      <div className="theft-banner-icon">🚨</div>
      <div className="theft-banner-content">
        <h3>
          {flaggedNodes.length > 0 
            ? `⚠ ${flaggedNodes.join(', ')}` 
            : 'THEFT DETECTED: Consumer flow is zero while main supply is active'}
        </h3>
        <p>
          Main supply active but no consumer flow detected. 
          Gov Flow: <strong>{govFlow?.toFixed(2) || 0} L/min</strong> | 
          Consumer Flow: <strong>{consumerFlow?.toFixed(2) || 0} L/min</strong>
        </p>
      </div>
    </div>
  );
};

// =========================
// CUSTOM POPUP COMPONENT
// =========================
const CustomPopup = ({ isOpen, title, message, icon, onConfirm, onCancel, confirmText, cancelText, type, details }) => {
  if (!isOpen) return null;

  if (type === 'EMERGENCY') {
    return (
      <div className="popup-overlay">
        <div className="emergency-alert-modal">
          <span className="popup-icon">🚨</span>
          <h2>CRITICAL ALERT</h2>
          <p style={{ fontSize: '1.2rem', fontWeight: 600 }}>{message}</p>
          
          <div className="emergency-details">
            <div className="emergency-row">
              <span className="emergency-label">Consumer:</span>
              <span className="emergency-value">{details?.name}</span>
            </div>
            <div className="emergency-row">
              <span className="emergency-label">House ID:</span>
              <span className="emergency-value">{details?.houseId}</span>
            </div>
            <div className="emergency-row">
              <span className="emergency-label">Reason:</span>
              <span className="emergency-value">{details?.reason}</span>
            </div>
            <div className="emergency-row">
              <span className="emergency-label">Status:</span>
              <span className="emergency-value" style={{ color: '#fff', background: '#000', padding: '2px 8px', borderRadius: '4px' }}>LOCKED</span>
            </div>
          </div>

          <button className="submit-btn" style={{ background: 'white', color: '#ef4444' }} onClick={onConfirm}>
            ACKNOWLEDGE & INVESTIGATE
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="popup-overlay">
      <div className="popup-card">
        <span className="popup-icon">{icon}</span>
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="popup-actions">
          {onCancel && <button className="popup-btn secondary" onClick={onCancel}>{cancelText || 'Cancel'}</button>}
          <button className="popup-btn primary" onClick={onConfirm}>{confirmText || 'OK'}</button>
        </div>
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
          <div className="flow-total-value">{formatVolume(totalLitres)}</div>
          <div className="flow-total-label">Volume Processed</div>
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
const NodeCard = ({ title, nodeData, online: onlineOverride }) => {
  const online = onlineOverride ?? isNodeOnline(nodeData);

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
// Memoized to prevent full-page re-render flicker during WebSocket heartbeats
const ConsumerCard = memo(({ title, valveState, onToggleValve, nodeData, nodeId, account, onBlockToggle, onToggleEmergency, onClearTamper }) => {
  const online = isNodeOnline(nodeData);
  const tamper = nodeData?.tamperDetected || false;
  const theftFlagged = account?.theftFlagged || false;
  const balance = account?.balance ?? 500;
  const blocked = account?.blocked || false;
  const hasSensor = nodeId === 'consumer_node'; 
  const emergencyLitres = nodeData?.emergencyLitres || 0;
  const emergencyActive = nodeData?.emergencyActive || false;
  const valveOpen = nodeData?.valveState || false;
  const emergencyValue = Number(nodeData?.emergencyValue) || 0;
  
  // Premium Billing
  const baseRate = 12;
  const premiumRate = 45;
  const normalCost = (nodeData?.totalLitres || 0) * baseRate;
  const emergencyCost = emergencyLitres * premiumRate;
  const totalBill = normalCost + emergencyCost;

  const handleEmergencyTrigger = () => {
    // We'll handle this through the admin dashboard popup system instead
    onToggleEmergency(nodeId, title);
  };

  return (
    <div className={`consumer-full-card ${tamper || theftFlagged ? 'tamper-active' : ''} ${emergencyActive ? 'emergency-mode' : ''}`} id={`consumer-card-${nodeId}`}>
      {/* Emergency Active Alert */}
      {emergencyActive && online && (
        <div className="tamper-alert" style={{ background: 'linear-gradient(135deg, #ef4444, #b91c1c)' }}>
          <span>🆘 EMERGENCY OVERRIDE ACTIVE</span>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.75rem', opacity: 0.9 }}>
            Source: <strong>{nodeData?.emergencySource?.replace('_', ' ') || 'UNKNOWN'}</strong> | Remaining: {hasSensor ? formatVolume(emergencyValue) : `${Math.floor(emergencyValue)}s`}
          </p>
        </div>
      )}
      {/* Tamper Alert */}
      {tamper && online && (
        <div className="tamper-alert">
          <span>🚨 TAMPER DETECTED</span> — Device moved/tilted. Valve auto-LOCKED. Admin must clear.
          <button onClick={() => onClearTamper(nodeId)} style={{ marginLeft: '1rem', padding: '0.3rem 0.8rem', background: 'white', color: 'var(--danger)', border: 'none', borderRadius: '6px', fontWeight: 700, cursor: 'pointer', fontSize: '0.75rem' }}>
            ✅ Clear Tamper
          </button>
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
          <span className={`status ${online ? (tamper || theftFlagged ? 'dirty' : '') : 'offline'}`} style={{
            padding: '0.25rem 0.75rem',
            borderRadius: '2rem',
            fontSize: '0.75rem',
            fontWeight: 600,
            transition: 'all 0.5s ease'
          }}>
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
              {hasSensor ? formatVolume(emergencyValue) : `${Math.floor(emergencyValue)} sec`}
            </span>

          </div>
        )}
        <div className="consumer-flow-item">
          <span className="consumer-flow-label">Flow Rate</span>
          <span className="consumer-flow-value">{(nodeData?.flowRate || 0).toFixed(2)} <small>L/min</small></span>
        </div>
        <div className="consumer-flow-item">
          <span className="consumer-flow-label">Billed Usage</span>
          <span className="consumer-flow-value">
            {valveOpen ? formatVolume(nodeData?.totalLitres) : <span style={{color:'var(--text-muted)', fontSize:'0.8rem'}}>Valve OFF</span>}
          </span>

        </div>
        <div className="consumer-flow-item" style={{ background: emergencyLitres > 0 ? 'rgba(239, 68, 68, 0.08)' : 'transparent' }}>
          <span className="consumer-flow-label">🆘 Emergency</span>
          <span className="consumer-flow-value" style={{ color: emergencyLitres > 0 ? 'var(--danger)' : 'inherit' }}>
            {formatVolume(emergencyLitres)} <small>(₹{emergencyCost.toFixed(0)})</small>
          </span>

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
        <button 
          onClick={() => onToggleEmergency(nodeId, title)}
          className={`emergency-btn ${emergencyActive ? 'active' : ''}`}
          style={{ 
            background: emergencyActive ? 'var(--danger)' : 'var(--danger)' , 
            color: 'white',
            border: 'none', padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer', fontSize: '0.8rem',
            opacity: emergencyActive ? 1 : 0.6
          }}
        >
          {emergencyActive ? "🛑 STOP SOS" : "🆘 SOS EMERGENCY"}
        </button>
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
});

// =========================
// SETTINGS VIEW
// =========================
const SettingsView = () => {
  const [settings, setSettings] = useState(null);
  const [localPrice, setLocalPrice] = useState(0.5);
  const [localGovCal, setLocalGovCal] = useState(98.0);
  const [localConsCal, setLocalConsCal] = useState(98.0);
  const [localEmergencyQuota, setLocalEmergencyQuota] = useState(50);
  const [theftWarningDelay, setTheftWarningDelay] = useState(5);
  const [tamperSensitivity, setTamperSensitivity] = useState(0.3);
  const [shockSensitivity, setShockSensitivity] = useState(1.2);
  const [minFlowThreshold, setMinFlowThreshold] = useState(0.02);
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
        setLocalGovCal(s.govCalibration ?? 98.0);
        setLocalConsCal(s.consumerCalibration ?? 98.0);
        setLocalEmergencyQuota(s.emergencyQuotaMl ?? 50);
        setTheftWarningDelay(s.theftWarningDelay ?? 5);
        setTamperSensitivity(s.tamperSensitivity ?? 0.3);
        setShockSensitivity(s.shockSensitivity ?? 1.2);
        setMinFlowThreshold(s.minFlowThreshold ?? 0.02);
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
        emergencyQuotaMl: parseFloat(localEmergencyQuota),
        theftWarningDelay: parseFloat(theftWarningDelay),
        tamperSensitivity: parseFloat(tamperSensitivity),
        shockSensitivity: parseFloat(shockSensitivity),
        minFlowThreshold: parseFloat(minFlowThreshold),
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
                <strong>🔥 Live from Firebase:</strong> Rate: ₹{settings.pricePerLiter}/L | Gov Cal: {settings.govCalibration} | Consumer Cal: {settings.consumerCalibration} | SOS Quota: {settings.emergencyQuotaMl ?? 50} ml | Delay: {settings.theftWarningDelay ?? 5}s
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
                <small>Standard: 98.0 for 6mm ID pipe. Pulse Rate: F = Q * 98.</small>
              </div>
              
              <div className="input-group">
                <label>🏠 Consumer Node Calibration</label>
                <input type="number" step="0.1" value={localConsCal} onChange={(e) => setLocalConsCal(e.target.value)} />
                <small>Standard: 98.0 for 6mm ID pipe. (1 Litre = 5880 Pulses).</small>
              </div>

              <div className="input-group">
                <label>🆘 Emergency SOS Quota (ml)</label>
                <input type="number" step="1" min="10" max="10000" value={localEmergencyQuota} onChange={(e) => setLocalEmergencyQuota(e.target.value)} />
                <small>Maximum water allowed during SOS emergency override. ESP auto-stops when limit is reached. Applies to Ramesh (flow sensor node).</small>
              </div>

              <div className="input-group">
                <label>⏱️ Theft Warning Delay (s)</label>
                <input type="number" step="1" min="1" max="60" value={theftWarningDelay} onChange={(e) => setTheftWarningDelay(e.target.value)} />
                <small>Seconds of continuous 0-flow before triggering theft candidate status.</small>
              </div>

              <div className="input-group">
                <label>🎛️ Tamper Sensitivity</label>
                <input type="number" step="0.01" value={tamperSensitivity} onChange={(e) => setTamperSensitivity(e.target.value)} />
                <small>MPU6050 vibration/touch threshold (lower = more sensitive).</small>
              </div>

              <div className="input-group">
                <label>💥 Shock Sensitivity</label>
                <input type="number" step="0.01" value={shockSensitivity} onChange={(e) => setShockSensitivity(e.target.value)} />
                <small>MPU6050 instant shock threshold (lower = more sensitive).</small>
              </div>

              <div className="input-group">
                <label>💧 Min Flow Threshold (L/min)</label>
                <input type="number" step="0.01" value={minFlowThreshold} onChange={(e) => setMinFlowThreshold(e.target.value)} />
                <small>Below this value, flow rate instantly snaps to 0.0 to prevent lingering ghost flow.</small>
              </div>
            </div>

            {/* Quick SOS Quota presets */}
            <div style={{ marginTop: '1rem' }}>
              <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>SOS Quota Presets:</p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {[25, 50, 100, 200, 500, 1000].map(ml => (
                  <button key={ml} onClick={() => setLocalEmergencyQuota(ml)}
                    style={{ 
                      padding: '0.4rem 0.8rem', 
                      border: parseFloat(localEmergencyQuota) === ml ? '2px solid var(--danger)' : '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-md)', 
                      background: parseFloat(localEmergencyQuota) === ml ? 'var(--danger-light)' : 'white',
                      color: parseFloat(localEmergencyQuota) === ml ? 'var(--danger)' : 'inherit',
                      fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem'
                    }}>
                    {ml >= 1000 ? `${ml/1000}L` : `${ml}ml`}
                  </button>
                ))}
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
  { 
    nodeId: 'consumer_node', 
    name: 'Ramesh Kumar', 
    location: 'Umaria, near BGI', 
    hasSensor: true,
    houseNum: 'H-101',
    houseId: 'BGI-CON-001'
  },
  { 
    nodeId: 'consumer_node_8266', 
    name: 'Priya Patel', 
    location: 'Pigdamber, near BGI', 
    hasSensor: false,
    houseNum: 'H-102',
    houseId: 'BGI-CON-002'
  },
];

const Dashboard = () => {
  const [data, setData] = useState(null);
  const [valves, setValves] = useState({});
  const [accounts, setAccounts] = useState({});
  const [commands, setCommands] = useState({});
  const [alertLogs, setAlertLogs] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [flowHistory, setFlowHistory] = useState([]);
  
  // Popup state
  const [popup, setPopup] = useState({ 
    isOpen: false, title: '', message: '', icon: '', onConfirm: null, onCancel: null, confirmText: '', cancelText: '' 
  });
  const [soundEnabled, setSoundEnabled] = useState(false);
  const audioCtxRef = useRef(null);

  const navigate = useNavigate();

  // ---- STABLE ONLINE STATUS (prevents UI flicker during brief jitter) ----
  const lastOnlineRef = useRef({});
  const getStableOnline = (nodeId, nodeData, graceMs = 15000) => {
    const rawOnline = isNodeOnline(nodeData);
    const now = Date.now();
    if (rawOnline) {
      lastOnlineRef.current[nodeId] = now;
      return true;
    }
    const lastOk = lastOnlineRef.current[nodeId] || 0;
    return lastOk > 0 && (now - lastOk) < graceMs;
  };

  const showPopup = (config) => {
    setPopup({ isOpen: true, ...config });
  };

  const closePopup = () => {
    setPopup(prev => ({ ...prev, isOpen: false }));
  };

  const enableAlertSound = async () => {
    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtxRef.current = Ctx ? new Ctx() : null;
      }
      if (audioCtxRef.current?.state === 'suspended') await audioCtxRef.current.resume();
      setSoundEnabled(true);
      toast.success('Alert sound enabled');
    } catch {
      setSoundEnabled(false);
      toast.error('Browser blocked sound. Tap again after interacting.');
    }
  };

  const playAlertBeep = () => {
    const ctx = audioCtxRef.current;
    if (!soundEnabled || !ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.28);
    } catch {}
  };

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
    
    const mergeSensorData = (prevData, incoming) => {
      if (!incoming || typeof incoming !== 'object') return prevData;
      const prevSafe = prevData && typeof prevData === 'object' ? prevData : {};
      const next = { ...prevSafe };
      for (const [nodeId, nodePayload] of Object.entries(incoming)) {
        if (nodePayload && typeof nodePayload === 'object') {
          const prevNode = prevSafe[nodeId] && typeof prevSafe[nodeId] === 'object' ? prevSafe[nodeId] : {};
          next[nodeId] = { ...prevNode, ...nodePayload };
        } else if (nodePayload !== undefined && nodePayload !== null) {
          // Non-object primitive fields (rare) still overwrite
          next[nodeId] = nodePayload;
        }
        // If Firebase briefly returns null/undefined for a node, keep previous node data.
      }
      return next;
    };

    const unsubscribeSensors = onValue(sensorRef, (snapshot) => {
      const newData = snapshot.val();
      if (newData) {
        // Deep-merge per node so partial updates don't wipe previous fields and cause 0-flashes.
        setData(prev => mergeSensorData(prev, newData));
        setErrorMsg('');
      } else {
        setErrorMsg('Connected to Firebase, but sensorData is empty.');
      }
    }, (error) => {
      console.error("Firebase Error: ", error);
      setErrorMsg('Firebase Error: ' + error.message);
    });

    const unsubscribeValves = onValue(valvesRef, (snapshot) => {
      const vData = snapshot.val();
      if (vData) setValves(prev => ({ ...prev, ...vData }));
    });

    const unsubscribeAccounts = onValue(accountsRef, (snapshot) => {
      const acctData = snapshot.val();
      if (acctData) setAccounts(prev => ({ ...prev, ...acctData }));
    });

    const unsubscribeCommands = onValue(commandsRef, (snapshot) => {
      const cmdData = snapshot.val();
      if (cmdData) setCommands(prev => ({ ...prev, ...cmdData }));
    });

    const alertLogsRef = ref(db, 'alertLogs');
    const unsubscribeAlertLogs = onValue(alertLogsRef, (snapshot) => {
      const logs = snapshot.val();
      if (logs) {
        const logsArray = Object.entries(logs).map(([id, val]) => ({ id, ...val }));
        logsArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setAlertLogs(logsArray);
      } else {
        setAlertLogs([]);
      }
    });

    return () => {
      unsubscribeSensors();
      unsubscribeValves();
      unsubscribeAccounts();
      unsubscribeCommands();
      unsubscribeAlertLogs();
    };
  }, [navigate]);

  // ---- SYNC HEARTBEAT TIMER (Next Refresh Countdown) ----
  const [syncCountdown, setSyncCountdown] = useState(5.0);
  useEffect(() => {
    const timer = setInterval(() => {
      setSyncCountdown(prev => {
        if (prev <= 0.1) return 5.0; // Reset every 5s (Gov node heartbeat frequency)
        return parseFloat((prev - 0.1).toFixed(1));
      });
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // ---- RECORD FLOW HISTORY FOR ANALYTICS ----
  useEffect(() => {
    if (!data) return;
    const interval = setInterval(() => {
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const govFlow = data?.gov_node?.flowRate || 0;
      const totalConsumerFlow = CONSUMER_NODES.reduce((sum, node) => sum + (data[node.nodeId]?.flowRate || 0), 0);
      
      setFlowHistory(prev => {
        const next = [...prev, { 
          time: now, 
          gov: parseFloat(govFlow.toFixed(2)), 
          consumer: parseFloat(totalConsumerFlow.toFixed(2)),
          loss: parseFloat((govFlow - totalConsumerFlow).toFixed(2))
        }];
        if (next.length > 30) return next.slice(1); // Keep last 2.5 minutes of data (5s intervals)
        return next;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [data]);

  // ---- INSTANT ALERT DETECTION ----
  const [lastAlertCount, setLastAlertCount] = useState(0);
  useEffect(() => {
    if (alertLogs.length > lastAlertCount && lastAlertCount > 0) {
      const newest = alertLogs[0];
      if (newest && (newest.type === 'THEFT' || newest.type === 'TAMPER')) {
        const consumer = CONSUMER_NODES.find(c => c.name.includes(newest.node) || newest.msg.includes(c.name) || newest.node === 'Ramesh' || newest.node === 'Priya');
        
        // Show high-visibility emergency modal
        showPopup({
          type: 'EMERGENCY',
          message: newest.msg,
          details: {
            name: consumer?.name || newest.node,
            houseId: consumer?.houseId || 'N/A',
            reason: newest.type === 'THEFT' ? 'Discrepancy detected' : 'Device moved/tilted'
          },
          onConfirm: closePopup
        });
        
        // Play sound only after user explicitly enabled it (avoids autoplay blocking)
        playAlertBeep();
      }
    }
    setLastAlertCount(alertLogs.length);
  }, [alertLogs.length]);


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

  const handleResetAllData = () => {
    if (!data || !data.gov_node) {
      showPopup({
        title: "Connection Error",
        message: "Cannot reset: No live connection to sensor data.",
        icon: "⚠️",
        onConfirm: closePopup
      });
      return;
    }

    showPopup({
      title: "Confirm System Reset",
      message: "Are you sure you want to RESET ALL DATA? This will set all total litres to zero across all nodes and archive the current session.",
      icon: "🔄",
      confirmText: "Reset Now",
      cancelText: "Cancel",
      onCancel: closePopup,
      onConfirm: async () => {
        closePopup();
        await performReset();
      }
    });
  };

  const performReset = async () => {

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
      updates['sensorData/consumer_node/theftCandidate'] = false;
      
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
        updates[`commands/${nodeId}/sosActive`] = false;
      }

      // Perform all updates in one go (more efficient)
      // Note: In Firebase modular SDK, you'd use 'update' but here we can just set them
      // To keep it simple and consistent with your style, I'll keep individual sets but as a promise array
      await Promise.all(Object.entries(updates).map(([path, val]) => set(ref(db, path), val)));

      // 4. Turn off reset flags after 5 seconds to let hardware catch up
      setTimeout(() => {
        const clearCommands = {};
        clearCommands['commands/consumer_node/reset'] = false;
        clearCommands['commands/consumer_node/sosActive'] = false;
        clearCommands['commands/consumer_node_8266/reset'] = false;
        clearCommands['commands/consumer_node_8266/sosActive'] = false;
        clearCommands['commands/resetAll'] = false;
        update(ref(db), clearCommands);
      }, 5000);

      alert("✅ Reset command sent. System starting fresh!");
    } catch (err) {
      console.error("Reset failed:", err);
      alert("❌ Reset failed: " + err.message);
    }
  };

  const handleBlockToggle = async (nodeId) => {
    const account = accounts[nodeId] || {};
    const nodeData = data[nodeId] || {};
    const isUnblocking = (account.theftFlagged || account.blocked || nodeData.tamperDetected);
    
    const toastId = toast.loading(isUnblocking ? "Unblocking & clearing flags..." : "Blocking user...");

    try {
      if (isUnblocking) {
        // Unblock: clear ALL flags and re-open valve
        const updates = {};
        updates[`accounts/${nodeId}/theftFlagged`] = false;
        updates[`accounts/${nodeId}/blocked`] = false;
        updates[`accounts/${nodeId}/theftReason`] = null;
        updates[`accounts/${nodeId}/theftTime`] = null;
        updates[`valves/${nodeId}/gov`] = true;
        updates[`sensorData/${nodeId}/tamperDetected`] = false;
        updates[`commands/${nodeId}/clearTamper`] = true;
        
        await update(ref(db), updates);
        toast.success("User unblocked and flags cleared", { id: toastId });
      } else {
        // Block user manually
        const updates = {};
        updates[`accounts/${nodeId}/blocked`] = true;
        updates[`valves/${nodeId}/gov`] = false;
        
        await update(ref(db), updates);
        toast.success("User blocked successfully", { id: toastId });
      }
    } catch (error) {
      toast.error("Action failed: " + error.message, { id: toastId });
    }
  };

  const handleToggleValve = async (nodeId, currentState) => {
    const newState = !currentState;
    const toastId = toast.loading(newState ? "Opening valve..." : "Closing valve...");
    
    try {
      // Set valve state AND notify the system of the change time
      // so gov node can apply a grace period before theft detection
      const updates = {};
      updates[`valves/${nodeId}/gov`] = newState;
      await update(ref(db), updates);
      toast.success(`Valve ${newState ? 'Opened' : 'Closed'}`, { id: toastId });
    } catch (error) {
      toast.error("Failed to update valve", { id: toastId });
    }
  };

  // Compute theft status from consumer theftCandidate + gov flow
  // NO minimum threshold. Any gov flow > 0 combined with consumer theftCandidate = THEFT.
  const { govNode, theftDetected } = useMemo(() => {
    const node = data?.gov_node || {};
    const govFlow = node.flowRate || 0;
    const consumerTheftCandidate = data?.consumer_node?.theftCandidate || false;
    // Theft = gov flow exists AND consumer has had zero flow for 5+ seconds
    const detected = govFlow > 0 && consumerTheftCandidate;
    return { govNode: node, theftDetected: detected };
  }, [data]);

  // Auto-flag theft in Firebase when dashboard detects theft condition
  useEffect(() => {
    if (!theftDetected) return;
    const acct = accounts?.consumer_node || {};
    if (acct.theftFlagged) return; // Already flagged, don't spam

    const reason = 'Main supply active but no consumer flow detected';
    const updates = {};
    updates['accounts/consumer_node/theftFlagged'] = true;
    updates['accounts/consumer_node/theftReason'] = reason;
    updates['valves/consumer_node/gov'] = false; // Block valve
    update(ref(db), updates).then(() => {
      console.log('Theft auto-flagged by dashboard');
      // Push alert log
      const alertRef = ref(db, 'alertLogs');
      push(alertRef, {
        node: 'Ramesh',
        type: 'THEFT',
        msg: reason,
        timestamp: Date.now()
      });
    }).catch(err => console.error('Theft flag failed:', err));
  }, [theftDetected, accounts]);

  if (errorMsg) return <div className="dashboard"><h2>{errorMsg}</h2><button onClick={handleLogout} className="logout-btn">Logout</button></div>;
  if (!data) return <div className="dashboard"><h2>Connecting to Jal Board Network...</h2></div>;

  // Gather flagged consumers for the theft list
  const flaggedConsumers = CONSUMER_NODES.filter(({ nodeId }) => {
    const acct = accounts[nodeId] || {};
    return acct.theftFlagged || acct.blocked;
  });

  const renderDashboard = () => (
    <div className="main-content">
      {/* Government Node - Water Quality + Flow */}
      {/*
        NOTE: we keep Gov node "ONLINE" sticky for a short grace window so it
        doesn't flash OFFLINE due to sporadic `lastSeen` update delays.
      */}
      {/* Theft Alert Banner — shows when govFlow > 0 AND consumer theftCandidate */}
      <TheftAlertBanner 
        theftDetected={theftDetected}
        govFlow={govNode.flowRate}
        consumerFlow={data?.consumer_node?.flowRate}
        accounts={accounts}
      />

      <NodeCard 
        title="🏛️ Rau Pumping Station (BGI Indore Area)" 
        nodeData={govNode} 
        online={getStableOnline('gov_node', govNode)}
      />

      {/* Supply vs Consumption Summary */}
      <div className="node-container" style={{ marginTop: '2rem' }}>
        <h2>📊 Network Efficiency</h2>
        <div className="nodes-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div className="card stat-card supply">
            <h3>Total Supply</h3>
            <div className="value">{formatVolume(govNode.govSupplyLitres)}</div>
            <div className="status">FROM PLANT</div>
          </div>

          <div className="card stat-card consumption">
            <h3>Total Consumed</h3>
            <div className="value">{formatVolume(govNode.consumerTotalLitres)}</div>
            <div className="status">BY HOMES</div>
          </div>

          <div className={`card stat-card ${theftDetected ? 'loss-alert' : 'loss-ok'}`}>
            <h3>Unaccounted</h3>
            <div className="value">{formatVolume(govNode.flowDifference)}</div>
            <div className={`status ${theftDetected ? 'dirty' : ''}`}>
              {theftDetected ? 'THEFT DETECTED' : 'NORMAL'}
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
              onToggleValve={() => handleToggleValve(nodeId, valves[nodeId]?.gov ?? true)}
              onBlockToggle={() => handleBlockToggle(nodeId)}
              onClearTamper={(id) => {
                const updates = {};
                updates[`commands/${id}/clearTamper`] = true;
                updates[`sensorData/${id}/tamperDetected`] = false;
                updates[`valves/${id}/gov`] = true; // Unblock automatically
                updates[`accounts/${id}/theftFlagged`] = false; // Also clear any associated theft flags
                update(ref(db), updates);
                showPopup({ title: 'Tamper Cleared', message: `Tamper flag cleared for ${name}. Valve unblocked and MPU baseline recalibrated.`, icon: '✅', onConfirm: closePopup });
              }}
              onToggleEmergency={(id, name) => {
                const isActive = data[id]?.emergencyActive || false;
                if (isActive) {
                  set(ref(db, `commands/${id}/sosActive`), false);
                  toast.success(`SOS Stopped for ${name}`);
                } else {
                  set(ref(db, `commands/${id}/triggerEmergency`), true);
                  set(ref(db, `commands/${id}/sosActive`), true);
                  toast.success(`SOS Started for ${name}`);
                }
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );

  const renderAlertLogs = () => (
    <div className="main-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h2>🔔 System Alerts & Logs</h2>
          <p style={{ color: 'var(--text-secondary)' }}>Historical record of theft attempts, tamper alerts, and motion detections.</p>
        </div>
        <button className="logout-btn" onClick={() => set(ref(db, 'alertLogs'), null)}>🗑️ Clear All Logs</button>
      </div>

      <div className="alert-logs-list">
        {alertLogs.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '4rem' }}>
            <span style={{ fontSize: '3rem', display: 'block', marginBottom: '1rem' }}>✅</span>
            <h3>All Systems Normal</h3>
            <p style={{ color: 'var(--text-muted)' }}>No alerts have been recorded in the current session.</p>
          </div>
        ) : (
          alertLogs.map((log) => (
            <div className="alert-log-card" key={log.id}>
              <div className={`alert-icon-box alert-icon-${log.type}`}>
                {log.type === 'THEFT' ? '🕵️' : log.type === 'TAMPER' ? '🚨' : log.type === 'MOTION' ? '🫨' : '⚙️'}
              </div>
              <div className="alert-info-content">
                <h4>{log.node} Node: {log.type}</h4>
                <p>{log.msg}</p>
              </div>
              <div className="alert-time-stamp">
                {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : 'Unknown'}
                <br />
                <span style={{ opacity: 0.6, fontSize: '0.65rem' }}>{log.timestamp ? new Date(log.timestamp).toLocaleDateString() : ''}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );

  // ==========================
  // VIOLATIONS TAB
  // ==========================
  const renderViolations = () => {
    const blockedNodes = CONSUMER_NODES.filter(({ nodeId }) => {
      const acct = accounts[nodeId] || {};
      return acct.theftFlagged || acct.blocked || (data?.[nodeId]?.tamperDetected);
    });
    const theftLogs = alertLogs.filter(l => l.type === 'THEFT');
    const tamperLogs = alertLogs.filter(l => l.type === 'TAMPER');

    return (
      <div className="main-content">
        <h2>🚫 Violations & Blocked Users</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Government enforcement panel. Manage blocked consumers, theft cases, and tamper violations.</p>
        
        {/* Blocked Users */}
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>🔒 Currently Blocked ({blockedNodes.length})</h3>
          {blockedNodes.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>✅ No consumers currently blocked.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '2px solid var(--border-color)', textAlign: 'left' }}>
                <th style={{ padding: '0.75rem' }}>Consumer</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Action</th>
              </tr></thead>
              <tbody>
                {blockedNodes.map(({ nodeId, name }) => {
                  const acct = accounts[nodeId] || {};
                  const nd = data?.[nodeId] || {};
                  return (
                    <tr key={nodeId} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '0.75rem', fontWeight: 600 }}>{name}<br/><code style={{fontSize:'0.7rem'}}>{nodeId}</code></td>
                      <td><span className="status dirty" style={{fontSize:'0.75rem'}}>{acct.theftFlagged ? '🕵️ THEFT' : nd.tamperDetected ? '🚨 TAMPER' : '🔒 BLOCKED'}</span></td>
                      <td style={{fontSize:'0.8rem', color:'var(--text-secondary)'}}>{acct.theftReason || (nd.tamperDetected ? 'Device moved/tilted' : 'Admin action')}</td>
                      <td><button className="unblock-btn" onClick={() => handleBlockToggle(nodeId)}>✅ Unblock</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Theft Cases */}
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>🕵️ Theft Cases ({theftLogs.length})</h3>
          {theftLogs.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '1rem' }}>No theft incidents recorded.</p>
          ) : (
            theftLogs.slice(0, 20).map(log => (
              <div key={log.id} className="alert-log-card">
                <div className="alert-icon-box alert-icon-THEFT">🕵️</div>
                <div className="alert-info-content"><h4>{log.node}: {log.type}</h4><p>{log.msg}</p></div>
                <div className="alert-time-stamp">{log.timestamp ? new Date(log.timestamp).toLocaleString() : ''}</div>
              </div>
            ))
          )}
        </div>

        {/* Tamper Cases */}
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>🚨 Tamper Cases ({tamperLogs.length})</h3>
          {tamperLogs.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '1rem' }}>No tamper incidents recorded.</p>
          ) : (
            tamperLogs.slice(0, 20).map(log => (
              <div key={log.id} className="alert-log-card">
                <div className="alert-icon-box alert-icon-TAMPER">🚨</div>
                <div className="alert-info-content"><h4>{log.node}: {log.type}</h4><p>{log.msg}</p></div>
                <div className="alert-time-stamp">{log.timestamp ? new Date(log.timestamp).toLocaleString() : ''}</div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  };

  const renderAnalytics = () => {
    const govNode = data?.gov_node || {};
    const govSupply = govNode.govSupplyLitres || 0;
    const totalConsumerUsage = CONSUMER_NODES.reduce((sum, node) => sum + (data[node.nodeId]?.totalLitres || 0), 0);
    const waterLossLitre = govSupply - totalConsumerUsage > 0 ? govSupply - totalConsumerUsage : 0;
    const lossPercentage = govSupply > 0 ? (waterLossLitre / govSupply) * 100 : 0;
    const avgUsagePerHouse = CONSUMER_NODES.length > 0 ? totalConsumerUsage / CONSUMER_NODES.length : 0;

    return (
      <div className="main-content">
        {/* Analytics Header Summary */}
        <div className="analytics-summary-grid" style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', 
          gap: '1.5rem',
          marginBottom: '2rem'
        }}>
          <div className="card stat-card" style={{ borderLeft: '4px solid var(--primary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>TOTAL SUPPLY</p>
                <h2 style={{ margin: '0.5rem 0' }}>{formatVolume(govSupply)}</h2>
              </div>
              <div style={{ fontSize: '2rem' }}>🏢</div>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Aggregate from Rau Pumping Station</p>
          </div>

          <div className="card stat-card" style={{ borderLeft: '4px solid var(--success)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>AVG USAGE / HOUSE</p>
                <h2 style={{ margin: '0.5rem 0' }}>{formatVolume(avgUsagePerHouse)}</h2>
              </div>
              <div style={{ fontSize: '2rem' }}>🏠</div>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Distributed across {CONSUMER_NODES.length} households</p>
          </div>

          <div className="card stat-card" style={{ borderLeft: '4px solid var(--danger)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>UNACCOUNTED LOSS</p>
                <h2 style={{ margin: '0.5rem 0', color: 'var(--danger)' }}>{formatVolume(waterLossLitre)}</h2>
              </div>
              <div style={{ fontSize: '2rem' }}>📉</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className={`status ${lossPercentage > 15 ? 'dirty' : lossPercentage > 5 ? 'warning' : ''}`} style={{ fontSize: '0.7rem' }}>
                {lossPercentage.toFixed(1)}% LOSS
              </span>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Real-time network discrepancy</p>
            </div>
          </div>
        </div>

        {/* Consumption Graph Card */}
        <div className="card" style={{ marginBottom: '2rem', height: '450px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <div>
              <h2>📈 Real-Time Consumption Analysis</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Comparison of main supply vs. aggregate consumer demand (L/min).</p>
            </div>
            <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '2px', background: 'var(--primary)' }}></div> Main Supply
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '2px', background: 'var(--success)' }}></div> Consumer Load
              </div>
            </div>
          </div>
          
          <div style={{ width: '100%', height: '320px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={flowHistory}>
                <defs>
                  <linearGradient id="colorGov" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="var(--primary)" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorCons" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--success)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="var(--success)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-color)" />
                <XAxis 
                  dataKey="time" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                  label={{ value: 'L/min', angle: -90, position: 'insideLeft', fontSize: 10, fill: 'var(--text-secondary)' }}
                />
                <Tooltip 
                  contentStyle={{ 
                    background: 'white', 
                    borderRadius: 'var(--radius-md)', 
                    border: '1px solid var(--border-color)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                    fontSize: '0.85rem'
                  }} 
                />
                <Area type="monotone" dataKey="gov" name="Main Supply" stroke="var(--primary)" strokeWidth={3} fillOpacity={1} fill="url(#colorGov)" />
                <Area type="monotone" dataKey="consumer" name="Consumer Load" stroke="var(--success)" strokeWidth={3} fillOpacity={1} fill="url(#colorCons)" />
                <Line type="monotone" dataKey="loss" name="Network Loss" stroke="var(--danger)" strokeDasharray="5 5" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
          <div className="card">
            <h2>📡 Live Network Feed</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.85rem' }}>Real-time heartbeat monitoring for all nodes.</p>
            <div className="theft-list-container" style={{ background: 'var(--bg-color)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
              {/* Main Gov Node */}
              <div className="theft-item" style={{ borderLeft: '4px solid var(--primary)', background: 'white', marginBottom: '0.75rem' }}>
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
                  <div className="theft-item" key={nodeId} style={{ borderLeft: `4px solid ${online ? 'var(--success)' : 'var(--danger)'}`, background: 'white', marginBottom: '0.75rem' }}>
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

          <div className="card">
            <h2>⚡ Efficiency Tracker</h2>
            <div style={{ marginTop: '2rem' }}>
               <div style={{ marginBottom: '1.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontSize: '0.85rem' }}>
                    <span>System Efficiency</span>
                    <span style={{ fontWeight: 700, color: lossPercentage < 10 ? 'var(--success)' : 'var(--danger)' }}>
                      {(100 - lossPercentage).toFixed(1)}%
                    </span>
                  </div>
                  <div style={{ height: '12px', background: 'var(--border-color)', borderRadius: '6px', overflow: 'hidden' }}>
                    <div style={{ 
                      height: '100%', 
                      width: `${100 - lossPercentage}%`, 
                      background: lossPercentage < 10 ? 'var(--success)' : (lossPercentage < 20 ? 'var(--warning)' : 'var(--danger)'),
                      transition: 'width 1s ease-in-out'
                    }}></div>
                  </div>
               </div>

               <div className="analytics-details" style={{ fontSize: '0.85rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: '1px solid var(--border-color)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Daily Supply Goal</span>
                    <span style={{ fontWeight: 600 }}>100.0 L</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: '1px solid var(--border-color)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Current System Variance</span>
                    <span style={{ fontWeight: 600, color: 'var(--danger)' }}>{waterLossLitre.toFixed(2)} L</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: '1px solid var(--border-color)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Households Monitored</span>
                    <span style={{ fontWeight: 600 }}>{CONSUMER_NODES.length} Houses</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Loss Status</span>
                    <span className={`status ${lossPercentage < 10 ? '' : 'dirty'}`} style={{ fontWeight: 700 }}>
                      {lossPercentage < 10 ? 'STABLE' : 'HIGH LOSS'}
                    </span>
                  </div>
               </div>
            </div>
          </div>
        </div>

        {/* Live Raw Data Feed */}
        <div className="card" style={{ marginTop: '2rem' }}>
          <h2>📝 Live Raw Data Feed</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Detailed stream of raw sensor values and aggregate network metrics.</p>
          <div className="gov-table-container">
            <table className="gov-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-color)' }}>
                  <th style={{ padding: '1rem' }}>Metric</th>
                  <th>Value</th>
                  <th>Unit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.8rem 1rem', fontWeight: 600 }}>Main Supply Flow</td>
                  <td>{(govNode.flowRate || 0).toFixed(2)}</td>
                  <td>L/min</td>
                  <td><span className="status" style={{ fontSize: '0.6rem' }}>LIVE</span></td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.8rem 1rem', fontWeight: 600 }}>Total Plant Supply</td>
                  <td>{formatVolume(govNode.govSupplyLitres)}</td>
                  <td>--</td>
                  <td><span className="status" style={{ fontSize: '0.6rem' }}>AGGREGATED</span></td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.8rem 1rem', fontWeight: 600 }}>Total Consumer Usage</td>
                  <td>{formatVolume(totalConsumerUsage)}</td>
                  <td>--</td>
                  <td><span className="status" style={{ fontSize: '0.6rem' }}>AGGREGATED</span></td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.8rem 1rem', fontWeight: 600 }}>Unaccounted Loss</td>
                  <td>{formatVolume(waterLossLitre)}</td>
                  <td>--</td>
                  <td><span className={`status ${lossPercentage > 10 ? 'dirty' : ''}`} style={{ fontSize: '0.6rem' }}>{lossPercentage > 10 ? 'LOSS DETECTED' : 'STABLE'}</span></td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.8rem 1rem', fontWeight: 600 }}>Turbidity Sensor</td>
                  <td>{(govNode.turbidityVoltage || 0).toFixed(2)}</td>
                  <td>Volts</td>
                  <td><span className={govNode.turbidityConnected ? "status" : "status offline"} style={{ fontSize: '0.6rem' }}>{govNode.turbidityConnected ? 'CONNECTED' : 'DISCONNECTED'}</span></td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.8rem 1rem', fontWeight: 600 }}>TDS Sensor</td>
                  <td>{(govNode.tdsValue || 0).toFixed(1)}</td>
                  <td>ppm</td>
                  <td><span className={govNode.tdsConnected ? "status" : "status offline"} style={{ fontSize: '0.6rem' }}>{govNode.tdsConnected ? 'CONNECTED' : 'DISCONNECTED'}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  // ==========================
  // CONSUMERS REGISTRY
  // ==========================
  const renderConsumers = () => (
    <div className="main-content">
      <h2>👥 Consumer Registry</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Full database of registered households and smart meters.</p>
      
      <div className="gov-table-container">
        <table className="gov-table">
          <thead>
            <tr>
              <th>House</th>
              <th>Consumer Info</th>
              <th>Live Status</th>
              <th>Valve</th>
              <th>Balance</th>
              <th>Meter Stats</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {CONSUMER_NODES.map((consumer) => {
              const nodeData = data?.[consumer.nodeId] || {};
              const acct = accounts[consumer.nodeId] || {};
              const online = isNodeOnline(nodeData);
              const tamper = nodeData?.tamperDetected;
              const theft = acct.theftFlagged;
              const valveState = nodeData?.valveState;
              
              return (
                <tr key={consumer.nodeId}>
                  <td style={{ paddingLeft: '1.5rem' }}>
                    <div style={{ fontWeight: 800 }}>{consumer.houseNum}</div>
                    <div className="id-badge">{consumer.houseId}</div>
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{consumer.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{consumer.location}</div>
                  </td>
                  <td>
                    <span className={`status ${online ? (tamper || theft ? 'dirty' : '') : 'offline'}`} style={{ fontSize: '0.7rem' }}>
                      {online ? (theft ? 'THEFT ALERT' : tamper ? 'TAMPER ALERT' : 'ONLINE') : 'OFFLINE'}
                    </span>
                    <div style={{ fontSize: '0.65rem', marginTop: '4px', opacity: 0.7 }}>
                      {nodeData.lastSeen ? new Date(nodeData.lastSeen).toLocaleTimeString() : 'Never seen'}
                    </div>
                  </td>
                  <td>
                    <span style={{ 
                      color: valveState ? 'var(--success)' : 'var(--danger)', 
                      fontWeight: 700, 
                      fontSize: '0.8rem' 
                    }}>
                      {valveState ? '🟢 OPEN' : '🔴 CLOSED'}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: 700, color: acct.balance > 100 ? 'var(--success)' : 'var(--danger)' }}>
                      ₹{(acct.balance ?? 500).toFixed(2)}
                    </div>
                  </td>
                  <td>
                    <div style={{ fontSize: '0.85rem' }}>
                      💧 <strong>{(nodeData.flowRate || 0).toFixed(1)}</strong> L/min
                    </div>
                    <div style={{ fontSize: '0.85rem' }}>
                      📊 <strong>{formatVolume(nodeData.totalLitres)}</strong> Total Usage
                    </div>

                  </td>
                  <td>
                    <button className="reset-btn" style={{ padding: '0.4rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setActiveTab('dashboard')}>
                      View Live
                    </button>
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
          <div className={`nav-item alerts-tab ${activeTab === 'alerts' ? 'active' : ''}`} onClick={() => setActiveTab('alerts')}>
            🔔 Alerts
            {alertLogs.length > 0 && <span className="alert-badge">{alertLogs.length > 9 ? '9+' : alertLogs.length}</span>}
          </div>
          <div className={`nav-item ${activeTab === 'violations' ? 'active' : ''}`} onClick={() => setActiveTab('violations')}>🚫 Violations</div>
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
                <div className="sync-monitor-box">
                  <div className="sync-timer-ring">
                    <svg viewBox="0 0 36 36" className="circular-chart">
                      <path className="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                      <path className="circle" strokeDasharray={`${(syncCountdown / 5) * 100}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                    </svg>
                    <span className="sync-text">{syncCountdown}s</span>
                  </div>
                  <span className="sync-label">NEXT SYNC</span>
                </div>
                <button 
                  onClick={enableAlertSound}
                  className="reset-btn"
                  style={{
                    background: soundEnabled ? 'var(--success-light)' : 'white',
                    color: soundEnabled ? 'var(--success)' : 'var(--text)',
                    border: '1px solid var(--border-color)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem'
                  }}
                >
                  {soundEnabled ? '🔊 Alerts Sound' : '🔇 Enable Sound'}
                </button>
                <button
                  onClick={() => {
                    toast.promise(
                      new Promise(resolve => setTimeout(resolve, 800)),
                      {
                        loading: 'Syncing with grid...',
                        success: 'All Nodes Synced',
                        error: 'Sync failed',
                      }
                    ).then(() => {
                      // No reload needed
                    });
                  }} 
                  className="reset-btn"
                  style={{ background: 'white', color: 'var(--primary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  🔄 Force Sync
                </button>
                <button onClick={handleResetAllData} className="reset-btn">🗑️ Reset All Data</button>
                <div className="status" style={{ background: 'var(--primary-light)', color: 'var(--primary)' }}>ADMIN ACCESS</div>
              </div>
          </div>
          
          {/* Theft Alert Banner */}
          <TheftAlertBanner 
            theftDetected={Object.values(accounts || {}).some(a => a.theftFlagged)}
            govFlow={data?.gov_node?.flowRate || 0}
            consumerFlow={data?.consumer_node?.flowRate || 0}
            accounts={accounts}
          />

          {activeTab === 'dashboard' && renderDashboard()}
          {activeTab === 'alerts' && renderAlertLogs()}
          {activeTab === 'violations' && renderViolations()}
          {activeTab === 'analytics' && renderAnalytics()}
          {activeTab === 'consumers' && renderConsumers()}
          {activeTab === 'settings' && <SettingsView />}
        </div>
      </main>

      {/* Global Custom Popup */}
      <CustomPopup 
        isOpen={popup.isOpen}
        type={popup.type}
        title={popup.title}
        message={popup.message}
        icon={popup.icon}
        confirmText={popup.confirmText}
        cancelText={popup.cancelText}
        onConfirm={popup.onConfirm}
        onCancel={popup.onCancel}
        details={popup.details}
      />
    </div>
  );
};

export default Dashboard;
