import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ref, onValue, set } from 'firebase/database';
import { db } from '../firebase';

const ConsumerDashboard = () => {
  const [govData, setGovData] = useState(null);
  const [lastSeen, setLastSeen] = useState(null);
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
      if (myData && myData.lastSeen) {
        setLastSeen(myData.lastSeen);
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

  const myNodeOnline = isNodeOnline(lastSeen);

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

    const tds = sensorData.tdsValue || 0;
    let tdsQuality = "GOOD";
    let tdsClass = "status";

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

    const turbVoltage = sensorData.turbidityVoltage || 0;
    const turbClass = sensorData.waterStatus === 'CLEAR' ? 'status' : 'status dirty';

    let finalQuality = "ACCEPTABLE";
    let finalClass = "status";

    if (sensorData.waterStatus === 'DIRTY') {
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
              <div className="value">{tds.toFixed(2)}<span className="unit">ppm</span></div>
              <div className={tdsClass}>{tdsQuality}</div>
          </div>
          
          <div className="card">
              <h3>Turbidity</h3>
              <div className="value">{turbVoltage.toFixed(2)}<span className="unit">V</span></div>
              <div className={turbClass}>{sensorData.waterStatus || "UNKNOWN"}</div>
          </div>

          <div className="card">
              <h3>Overall Quality</h3>
              <div className="value" style={{ fontSize: '1.4rem', margin: '0.75rem 0' }}>{finalQuality}</div>
              <div className={finalClass}>VERIFIED</div>
          </div>
        </div>
      </div>
    );
  };

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

        <div className="valve-card" style={{ marginBottom: '2.5rem', opacity: myNodeOnline ? 1 : 0.6 }}>
            <div className="valve-info">
              <h3>🏠 Main Water Valve</h3>
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

        {renderQualityCard(govData, "🏛️ Gov Water Supply Info")}
      </div>
    </div>
  );
};

export default ConsumerDashboard;
