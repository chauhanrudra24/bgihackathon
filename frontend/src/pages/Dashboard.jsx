import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ref, onValue, set } from 'firebase/database';
import { db } from '../firebase';

const isNodeOnline = (nodeData) => {
  if (!nodeData || !nodeData.lastSeen) return false;
  return (Date.now() - nodeData.lastSeen) < 20000;
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
// =========================
const FlowMeterCard = ({ flowRate, totalLitres, label }) => {
  return (
    <div className="card flow-card" id={`flow-card-${label}`}>
      <h3>💧 {label}</h3>
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

  if (!online) {
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

  const tdsConnected = nodeData.tdsConnected !== false;
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

  const turbConnected = nodeData.turbidityConnected !== false;
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
        <span className="status">● ONLINE</span>
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
          label="Main Supply Flow (YF-S201)"
        />
      </div>
    </div>
  );
};

// =========================
// CONSUMER VALVE + FLOW CARD
// =========================
const ConsumerCard = ({ title, valveState, onToggleValve, nodeData, nodeId }) => {
  const online = isNodeOnline(nodeData);
  const tamper = nodeData?.tamperDetected || false;

  return (
    <div className={`consumer-full-card ${tamper ? 'tamper-active' : ''}`} id={`consumer-card-${nodeId}`}>
      {/* Tamper Alert */}
      {tamper && online && (
        <div className="tamper-alert">
          <span>🚨 TAMPER DETECTED</span> — Flow detected while valve is CLOSED. Possible bypass or pipe cut.
        </div>
      )}

      {/* Header */}
      <div className="consumer-card-header">
        <div>
          <h3>{title}</h3>
          <p className="consumer-status-text">
            {online ? (tamper ? 'TAMPER ALERT' : 'Active') : 'Offline'}
          </p>
        </div>
        <span className={`status ${online ? (tamper ? 'dirty' : '') : 'offline'}`}>
          {online ? (tamper ? '⚠ ALERT' : '● ONLINE') : 'OFFLINE'}
        </span>
      </div>

      {/* Flow Data */}
      {online && (
        <div className="consumer-flow-row">
          <div className="consumer-flow-item">
            <span className="consumer-flow-label">Flow Rate</span>
            <span className="consumer-flow-value">{(nodeData?.flowRate || 0).toFixed(1)} <small>L/min</small></span>
          </div>
          <div className="consumer-flow-item">
            <span className="consumer-flow-label">Total Usage</span>
            <span className="consumer-flow-value">{(nodeData?.totalLitres || 0).toFixed(2)} <small>L</small></span>
          </div>
          <div className="consumer-flow-item">
            <span className="consumer-flow-label">Valve</span>
            <span className={`consumer-flow-value ${valveState ? 'valve-open' : 'valve-closed'}`}>
              {valveState ? '🟢 OPEN' : '🔴 CLOSED'}
            </span>
          </div>
        </div>
      )}

      {/* Valve Control */}
      <div className="consumer-card-footer">
        <button 
          disabled={!online}
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
// MAIN DASHBOARD
// =========================
const Dashboard = () => {
  const [data, setData] = useState(null);
  const [valves, setValves] = useState({});
  const [errorMsg, setErrorMsg] = useState('');
  const [countdown, setCountdown] = useState(5);
  const navigate = useNavigate();

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if (user.role !== 'admin') {
      navigate('/');
      return;
    }

    const sensorRef = ref(db, 'sensorData');
    const valvesRef = ref(db, 'valves');
    
    const unsubscribeSensors = onValue(sensorRef, (snapshot) => {
      const newData = snapshot.val();
      if (newData) {
        setData(newData);
        setCountdown(5);
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

    return () => {
      unsubscribeSensors();
      unsubscribeValves();
    };
  }, [navigate]);

  useEffect(() => {
    if (!data) return;
    const interval = setInterval(() => {
      setCountdown(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [data]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/');
  };

  if (errorMsg) return <div className="dashboard"><h2>{errorMsg}</h2><button onClick={handleLogout} className="logout-btn">Logout</button></div>;
  if (!data) return <div className="dashboard"><h2>Connecting to Jal Board Network...</h2></div>;

  const govNode = data.gov_node || {};
  const theftStatus = govNode.theftStatus || 'NORMAL';

  return (
    <div className="gov-dashboard-layout">
      {/* Sidebar for Laptop */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div style={{ fontSize: '1.5rem' }}>💧</div>
          <h2>Jal Board</h2>
        </div>
        
        <nav className="sidebar-nav">
          <div className="nav-item active">📊 Dashboard</div>
          <div className="nav-item">📈 Analytics</div>
          <div className="nav-item">👥 Consumers</div>
          <div className="nav-item">⚙️ Settings</div>
        </nav>

        <div className="sidebar-footer">
          <div className="nav-item" onClick={handleLogout}>🚪 Logout</div>
        </div>
      </aside>

      <main className="main-content-area">
        <div className="dashboard">
          <div className="header-flex">
              <h1>🏛️ Government Control Center</h1>
              <div className="status" style={{ background: 'var(--primary-light)', color: 'var(--primary)' }}>ADMIN ACCESS</div>
          </div>
          
          {/* Theft Alert Banner */}
          <TheftAlertBanner 
            theftStatus={theftStatus}
            govSupply={govNode.govSupplyLitres}
            consumerTotal={govNode.consumerTotalLitres}
            difference={govNode.flowDifference}
          />

          <div className="update-timer">
              {countdown > 0 ? `Live data sync in ` : ''} 
              <span>{countdown > 0 ? `${countdown}s` : 'Syncing...'}</span>
          </div>

          <div className="main-content">
            {/* Government Node - Water Quality + Flow */}
            <NodeCard 
              title="Sector-12 Pumping Station" 
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

            {/* Consumer Control Section */}
            <div className="node-container" style={{ marginTop: '2.5rem' }}>
              <h2>🏠 Smart Meter Management</h2>
              <div className="consumer-grid">
                <ConsumerCard 
                  title="Ramesh Kumar (House 42-B)"
                  nodeId="consumer_node"
                  valveState={valves.consumer_node}
                  nodeData={data.consumer_node}
                  onToggleValve={() => set(ref(db, `valves/consumer_node`), !valves.consumer_node)}
                />
                
                <ConsumerCard 
                  title="Priya Patel (House 104)"
                  nodeId="consumer_node_8266"
                  valveState={valves.consumer_node_8266}
                  nodeData={data.consumer_node_8266}
                  onToggleValve={() => set(ref(db, `valves/consumer_node_8266`), !valves.consumer_node_8266)}
                />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
