import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ref, onValue, set } from 'firebase/database';
import { db } from '../firebase';

const ConsumerDashboard = () => {
  const [govData, setGovData] = useState(null);
  const [myNodeData, setMyNodeData] = useState(null);
  const [valveState, setValveState] = useState(false);
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
      setValveState(snapshot.val() || false);
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
    set(ref(db, `valves/${nodeId}`), !valveState);
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
        <div className="header-flex">
            <h1>Welcome, {user.name}</h1>
            <button onClick={handleLogout} className="logout-btn">Logout</button>
        </div>
        
        <div className="update-timer">
            Next update in <span>{countdown}s</span>
        </div>

        {/* Tamper Alert Banner */}
        {tamperDetected && myNodeOnline && (
          <div className="theft-banner alert" style={{ marginBottom: '2rem' }}>
            <div className="theft-banner-icon">🚨</div>
            <div className="theft-banner-content">
              <h3>TAMPER ALERT: Unauthorized Flow Detected!</h3>
              <p>Water is flowing through your meter while the valve is <strong>CLOSED</strong>. Possible bypass or pipe cut detected. Contact authorities immediately.</p>
            </div>
          </div>
        )}

        {/* My Home Section */}
        <div className="node-container" style={{ marginBottom: '2.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem', gap: '10px' }}>
            <h2>🏠 My Home Water System</h2>
            <span className={`status ${myNodeOnline ? (tamperDetected ? 'dirty' : '') : 'offline'}`}>
              {myNodeOnline ? (tamperDetected ? '⚠ TAMPER' : '● ONLINE') : 'OFFLINE'}
            </span>
          </div>
          
          {/* Valve Control */}
          <div className="valve-card" style={{ marginBottom: '1.5rem', opacity: myNodeOnline ? 1 : 0.6 }}>
              <div className="valve-info">
                <h3>🚰 Main Water Valve</h3>
                <p>{myNodeOnline ? 'Active Control' : 'Hardware Offline - Control Unavailable'}</p>
              </div>
              <button 
                disabled={!myNodeOnline}
                onClick={toggleValve} 
                className={`valve-btn ${valveState ? 'open' : 'closed'}`}
              >
                {valveState ? "OPEN" : "CLOSED"}
              </button>
          </div>

          {/* Flow Data Cards */}
          {myNodeOnline && (
            <div className="nodes-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
              <div className="card">
                <h3>💧 Current Flow</h3>
                <div className="value">
                  {(myNodeData?.flowRate || 0).toFixed(1)}
                  <span className="unit">L/min</span>
                </div>
                {myNodeData?.flowRate > 0 ? (
                  <div className="flow-active-indicator">
                    <span className="flow-dot"></span> Water Flowing
                  </div>
                ) : (
                  <div className="status offline">No Flow</div>
                )}
              </div>

              <div className="card">
                <h3>📊 Total Usage</h3>
                <div className="value">
                  {(myNodeData?.totalLitres || 0).toFixed(2)}
                  <span className="unit">L</span>
                </div>
                <div className="status">SINCE BOOT</div>
              </div>

              <div className="card">
                <h3>🔒 Security</h3>
                <div className="value" style={{ fontSize: '1.5rem', margin: '0.75rem 0' }}>
                  {tamperDetected ? 'TAMPER' : 'SECURE'}
                </div>
                <div className={`status ${tamperDetected ? 'dirty' : ''}`}>
                  {tamperDetected ? '⚠ CHECK PIPES' : '✓ ALL CLEAR'}
                </div>
              </div>
            </div>
          )}

          {!myNodeOnline && (
            <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
              <h2 style={{ color: 'var(--warning)', margin: 0 }}>🔌 Home Node Offline</h2>
              <p style={{ color: 'var(--text-secondary)', marginTop: '1rem' }}>
                Waiting for your home ESP device to connect...
              </p>
            </div>
          )}
        </div>

        {/* Gov Water Quality Info */}
        {renderQualityCard(govData, "🏛️ Rau Pumping Station (BGI Indore Area)")}
      </div>
    </div>
  );
};

export default ConsumerDashboard;
