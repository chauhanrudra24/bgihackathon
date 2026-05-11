import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ref, onValue, set } from 'firebase/database';
import { db } from '../firebase';

const ConsumerDashboard = () => {
  const [govData, setGovData] = useState(null);
  const [myNodeData, setMyNodeData] = useState(null);
  const [valveData, setValveData] = useState({ gov: true, user: true });
  const [errorMsg, setErrorMsg] = useState('');
  const [countdown, setCountdown] = useState(5);
  
  const { nodeId } = useParams();
  const navigate = useNavigate();

  const user = JSON.parse(localStorage.getItem('user') || '{}');

  useEffect(() => {
    if (user.role !== 'consumer' || user.nodeId !== nodeId) {
      navigate('/');
      return;
    }

    const govSensorRef = ref(db, `sensorData/gov_node`);
    const myNodeRef = ref(db, `sensorData/${nodeId}`);
    const valveRef = ref(db, `valves/${nodeId}`);
    
    const unsubscribeGovSensor = onValue(govSensorRef, (snapshot) => {
      const govNewData = snapshot.val();
      if (govNewData) {
        setGovData(govNewData);
        setCountdown(5);
      }
    }, (error) => {
      setErrorMsg('Firebase Error: ' + error.message);
    });

    const unsubscribeMyNode = onValue(myNodeRef, (snapshot) => {
      const myData = snapshot.val();
      if (myData) {
        setMyNodeData(myData);
      }
    });

    const unsubscribeValve = onValue(valveRef, (snapshot) => {
      const vData = snapshot.val();
      if (vData) {
        setValveData(vData);
      }
    });

    return () => {
      unsubscribeGovSensor();
      unsubscribeMyNode();
      unsubscribeValve();
    };
  }, [nodeId, navigate, user.role, user.nodeId]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/');
  };

  const toggleValve = () => {
    if (!valveData.gov) return; // Cant toggle if gov cut supply
    set(ref(db, `valves/${nodeId}/user`), !valveData.user);
  };

  const isNodeOnline = (timestamp) => {
    if (!timestamp) return false;
    return (Date.now() - timestamp) < 20000;
  };

  const myNodeOnline = isNodeOnline(myNodeData?.lastSeen);
  const tamperDetected = myNodeData?.tamperDetected || false;

  // Water quality from gov node
  const renderQualityCard = (sensorData, title) => {
    const online = isNodeOnline(sensorData?.lastSeen);

    if (!online) {
      return (
        <div className="node-container">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem', gap: '10px' }}>
            <h2>{title}</h2>
            <span className="status offline">OFFLINE</span>
          </div>
          <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
            <h2 style={{ color: 'var(--warning)', margin: 0 }}>🔌 Main Plant Disconnected</h2>
            <p style={{ color: 'var(--text-secondary)', marginTop: '1rem' }}>Waiting for Government Pumping Station to come back online...</p>
          </div>
        </div>
      );
    }

    const tdsConnected = sensorData.tdsConnected !== false;
    const tds = tdsConnected ? (sensorData.tdsValue || 0) : 0;
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

    const turbConnected = sensorData.turbidityConnected !== false;
    const turbVoltage = turbConnected ? (sensorData.turbidityVoltage || 0) : 0;
    const turbStatus = turbConnected ? (sensorData.waterStatus || "UNKNOWN") : "NOT CONNECTED";
    
    let turbClass = "status";
    if (!turbConnected) turbClass = "status offline";
    else if (sensorData.waterStatus === 'DIRTY') turbClass = "status dirty";

    let finalQuality = "ACCEPTABLE";
    let finalClass = "status";

    if (!turbConnected || !tdsConnected) {
      finalQuality = "SENSOR ERROR";
      finalClass = "status warning";
    } else if (sensorData.waterStatus === 'DIRTY') {
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
              <div className="value" style={{ fontSize: '1.4rem', margin: '0.75rem 0' }}>{finalQuality}</div>
              <div className={finalClass}>{(!turbConnected || !tdsConnected) ? "CHECK SENSORS" : "VERIFIED"}</div>
          </div>
        </div>
      </div>
    );
  };

  if (errorMsg) return <div className="dashboard"><h2>{errorMsg}</h2><button onClick={handleLogout} className="logout-btn">Logout</button></div>;

  return (
    <div className="dashboard-container">
      <div className="dashboard">
        <header className="header-flex" style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Good Morning,</p>
              <h1 style={{ fontSize: '1.5rem' }}>{user.name}</h1>
            </div>
            <button onClick={handleLogout} className="logout-btn">Logout</button>
        </header>
        
        {/* Tamper Alert Banner */}
        {tamperDetected && myNodeOnline && (
          <div className="theft-banner alert" style={{ marginBottom: '2rem' }}>
            <div className="theft-banner-icon">🚨</div>
            <div className="theft-banner-content">
              <h3>UNAUTHORIZED FLOW</h3>
              <p>Water flow detected while valve is CLOSED. Check for leaks or tampering.</p>
            </div>
          </div>
        )}

        {/* Gov Supply Alert */}
        {!valveData.gov && myNodeOnline && (
          <div className="theft-banner suspicious" style={{ marginBottom: '2rem' }}>
            <div className="theft-banner-icon">🛑</div>
            <div className="theft-banner-content">
              <h3>SUPPLY SUSPENDED</h3>
              <p>The Government has temporarily suspended water supply to your node. Please contact the Jal Board for details.</p>
            </div>
          </div>
        )}

        {/* My Home Section */}
        <section className="node-container">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
            <h2 style={{ fontSize: '1.1rem', margin: 0 }}>🏠 My Water System</h2>
            <span className={`status ${myNodeOnline ? (tamperDetected ? 'dirty' : (!valveData.gov ? 'warning' : '')) : 'offline'}`}>
              {myNodeOnline ? (tamperDetected ? '⚠ ALERT' : (!valveData.gov ? '🛑 CUT' : '● ONLINE')) : 'OFFLINE'}
            </span>
          </div>
          
          {/* Main Control Card */}
          <div className="card" style={{ 
            marginBottom: '1.5rem', 
            background: !valveData.gov ? 'var(--bg-color)' : 'linear-gradient(135deg, var(--surface-color), var(--primary-light))', 
            border: !valveData.gov ? '1px solid var(--border-color)' : '1px solid var(--primary)',
            opacity: !valveData.gov ? 0.8 : 1
          }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="valve-info">
                  <h3 style={{ color: !valveData.gov ? 'var(--text-muted)' : 'var(--primary)' }}>
                    {!valveData.gov ? 'Supply Cut' : 'Main Valve'}
                  </h3>
                  <p style={{ fontSize: '0.8rem' }}>
                    {!valveData.gov ? 'Government Override Active' : (myNodeOnline ? 'Active Control' : 'Device Offline')}
                  </p>
                </div>
                <button 
                  disabled={!myNodeOnline || !valveData.gov}
                  onClick={toggleValve} 
                  className={`valve-btn ${valveData.user ? 'open' : 'closed'}`}
                  style={{ padding: '0.6rem 1.5rem' }}
                >
                  {!valveData.gov ? "LOCKED" : (valveData.user ? "ON" : "OFF")}
                </button>
              </div>
          </div>

          {/* Flow Data Cards */}
          {myNodeOnline ? (
            <div className="nodes-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
              <div className="card">
                <h3>Current Flow</h3>
                <div className="value" style={{ fontSize: '1.8rem' }}>
                  {(myNodeData?.flowRate || 0).toFixed(1)}
                  <span className="unit">L/min</span>
                </div>
                {myNodeData?.flowRate > 0 && (
                  <div className="flow-active-indicator" style={{ transform: 'scale(0.8)', origin: 'left' }}>
                    <span className="flow-dot"></span> Flowing
                  </div>
                )}
              </div>

              <div className="card">
                <h3>Total Usage</h3>
                <div className="value" style={{ fontSize: '1.8rem' }}>
                  {(myNodeData?.totalLitres || 0).toFixed(1)}
                  <span className="unit">L</span>
                </div>
                <div className="status" style={{ fontSize: '0.6rem' }}>TODAY</div>
              </div>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', padding: '2rem', background: 'var(--bg-color)' }}>
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Waiting for hardware connection...</p>
            </div>
          )}
        </section>

        <div style={{ height: '2rem' }}></div>

        {/* Gov Water Quality Info */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem', gap: '8px' }}>
            <h2 style={{ fontSize: '1.1rem', margin: 0 }}>🏛️ City Supply</h2>
            <span className="status" style={{ fontSize: '0.6rem' }}>LIVE QUALITY</span>
          </div>
          {renderQualityCard(govData, "Pumping Station")}
        </section>

        <div className="update-timer">
            Refresh in <span>{countdown}s</span>
        </div>
      </div>
    </div>
  );
};

export default ConsumerDashboard;
