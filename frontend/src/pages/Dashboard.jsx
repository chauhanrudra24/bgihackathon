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
const ConsumerCard = ({ title, valveState, onToggleValve, nodeData, nodeId, account, onBlockToggle }) => {
  const online = isNodeOnline(nodeData);
  const tamper = nodeData?.tamperDetected || false;
  const theftFlagged = account?.theftFlagged || false;
  const balance = account?.balance ?? 500;
  const blocked = account?.blocked || false;

  return (
    <div className={`consumer-full-card ${tamper || theftFlagged ? 'tamper-active' : ''}`} id={`consumer-card-${nodeId}`}>
      {/* Tamper Alert */}
      {tamper && online && (
        <div className="tamper-alert">
          <span>🚨 TAMPER DETECTED</span> — Flow detected while valve is CLOSED. Possible bypass or pipe cut.
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
            {online ? (tamper || theftFlagged ? '⚠ ALERT' : '● ONLINE') : 'OFFLINE'}
          </span>
        </div>
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
          disabled={!online || theftFlagged || blocked}
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
const CONSUMER_NODES = [
  { nodeId: 'consumer_node', name: 'Ramesh Kumar', location: 'Umaria, near BGI' },
  { nodeId: 'consumer_node_8266', name: 'Priya Patel', location: 'Pigdamber, near BGI' },
];

const Dashboard = () => {
  const [data, setData] = useState(null);
  const [valves, setValves] = useState({});
  const [accounts, setAccounts] = useState({});
  const [errorMsg, setErrorMsg] = useState('');
  const [countdown, setCountdown] = useState(5);
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

    const unsubscribeAccounts = onValue(accountsRef, (snapshot) => {
      setAccounts(snapshot.val() || {});
    });

    return () => {
      unsubscribeSensors();
      unsubscribeValves();
      unsubscribeAccounts();
    };
  }, [navigate]);

  // ===== AUTO THEFT DETECTION =====
  // If gov supply is active (flowRate > 0) but a consumer's valve is open and their flow is 0, flag as suspicious
  useEffect(() => {
    if (!data) return;
    const govNode = data.gov_node;
    const govOnline = isNodeOnline(govNode);
    const govFlowing = govOnline && (govNode?.flowRate || 0) > 0;

    if (!govFlowing) return;

    CONSUMER_NODES.forEach(({ nodeId }) => {
      const consumerData = data[nodeId];
      const consumerOnline = isNodeOnline(consumerData);
      const valve = valves[nodeId];
      const valveOpen = valve?.gov !== false && valve?.user !== false;
      const consumerFlow = consumerData?.flowRate || 0;
      const account = accounts[nodeId] || {};

      // If gov supply is active, consumer is online, valve is open, but consumer flow is zero → flag
      if (consumerOnline && valveOpen && consumerFlow === 0 && !account.theftFlagged) {
        set(ref(db, `accounts/${nodeId}/theftFlagged`), true);
        set(ref(db, `accounts/${nodeId}/theftReason`), 'Main supply active but no consumer flow detected');
        set(ref(db, `accounts/${nodeId}/theftTime`), Date.now());
        // Auto-block the consumer valve
        set(ref(db, `valves/${nodeId}/gov`), false);
      }
    });
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

  const handleResetAllData = async () => {
    if (!window.confirm("⚠️ Are you sure you want to RESET ALL DATA? This will set all total litres to zero across all nodes and start fresh.")) {
      return;
    }

    try {
      // 1. Send reset command to hardware
      await set(ref(db, 'commands/resetAll'), true);
      
      // 2. Clear totals in RTDB immediately for snappy UI
      await set(ref(db, 'sensorData/gov_node/totalLitres'), 0);
      await set(ref(db, 'sensorData/gov_node/govSupplyLitres'), 0);
      await set(ref(db, 'sensorData/gov_node/consumerTotalLitres'), 0);
      await set(ref(db, 'sensorData/gov_node/flowDifference'), 0);
      
      await set(ref(db, 'sensorData/consumer_node/totalLitres'), 0);
      await set(ref(db, 'sensorData/consumer_node_8266/totalLitres'), 0);

      // 3. Reset Accounts and Valves (Unblock everyone)
      for (const node of CONSUMER_NODES) {
        const { nodeId } = node;
        await set(ref(db, `accounts/${nodeId}/blocked`), false);
        await set(ref(db, `accounts/${nodeId}/theftFlagged`), false);
        await set(ref(db, `accounts/${nodeId}/theftReason`), null);
        await set(ref(db, `accounts/${nodeId}/theftTime`), null);
        await set(ref(db, `valves/${nodeId}/gov`), true);
        await set(ref(db, `valves/${nodeId}/user`), true); // Also reset user switch to ON
      }

      // 4. Reset Government Node Stats
      await set(ref(db, 'sensorData/gov_node/theftStatus'), 'NORMAL');

      // 5. Turn off reset flag after 3 seconds
      setTimeout(() => {
        set(ref(db, 'commands/resetAll'), false);
      }, 3000);

      alert("✅ Reset command sent. System starting fresh!");
    } catch (err) {
      console.error("Reset failed:", err);
      alert("❌ Reset failed. Check console.");
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
      <div className="card" style={{ padding: '4rem', textAlign: 'center' }}>
        <h2 style={{ fontSize: '2rem' }}>📈 Supply Trends</h2>
        <p style={{ color: 'var(--text-secondary)' }}>Advanced analytics and consumption history charts will be visible here.</p>
        <div style={{ marginTop: '2rem', height: '200px', background: 'var(--bg-color)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: 'var(--text-muted)' }}>[ Trend Analysis Placeholder ]</span>
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

          <div className="update-timer">
              {countdown > 0 ? `Live data sync in ` : ''} 
              <span>{countdown > 0 ? `${countdown}s` : 'Syncing...'}</span>
          </div>

          {activeTab === 'dashboard' && renderDashboard()}
          {activeTab === 'analytics' && renderAnalytics()}
          {activeTab === 'consumers' && renderConsumers()}
          {activeTab === 'settings' && (
            <div className="main-content">
                <div className="card">
                    <h2>⚙️ System Settings</h2>
                    <p style={{ color: 'var(--text-secondary)' }}>Global thresholds and node configurations.</p>
                </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
