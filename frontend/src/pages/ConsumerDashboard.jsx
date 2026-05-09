import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ref, onValue, set } from 'firebase/database';
import { db } from '../firebase';

const ConsumerDashboard = () => {
  const [data, setData] = useState(null);
  const [govData, setGovData] = useState(null);
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

    const sensorRef = ref(db, `sensorData/${nodeId}`);
    const govSensorRef = ref(db, `sensorData/gov_node`);
    const valveRef = ref(db, `valves/${nodeId}`);
    
    const unsubscribeSensor = onValue(sensorRef, (snapshot) => {
      const newData = snapshot.val();
      if (newData) {
        setData(newData);
        setCountdown(5);
        setErrorMsg('');
      } else {
        setErrorMsg('Waiting for sensor data...');
      }
    }, (error) => {
      setErrorMsg('Firebase Error: ' + error.message);
    });

    const unsubscribeGovSensor = onValue(govSensorRef, (snapshot) => {
      const govNewData = snapshot.val();
      if (govNewData) {
        setGovData(govNewData);
      }
    });

    const unsubscribeValve = onValue(valveRef, (snapshot) => {
      setValveState(snapshot.val() || false);
    });

    return () => {
      unsubscribeSensor();
      unsubscribeGovSensor();
      unsubscribeValve();
    };
  }, [nodeId, navigate, user.role, user.nodeId]);

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

  const toggleValve = () => {
    set(ref(db, `valves/${nodeId}`), !valveState);
  };

  if (errorMsg && !data) return <div className="dashboard"><h2>{errorMsg}</h2><button onClick={handleLogout} className="logout-btn">Logout</button></div>;
  if (!data) return <div className="dashboard"><h2>Waiting for ESP32/Firebase connection...</h2></div>;

  const renderQualityCard = (sensorData, title) => {
    if (!sensorData || Object.keys(sensorData).length === 0) {
      return (
        <div className="node-container" style={{background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '15px', marginBottom: '20px'}}>
          <h2 style={{color: '#fff', marginBottom: '15px', marginTop: 0}}>{title}</h2>
          <div className="card" style={{borderLeftColor: '#f59e0b', textAlign: 'center', padding: '40px 20px', margin: 0}}>
            <h2 style={{color: '#f59e0b', margin: 0}}>🔌 Node Disconnected</h2>
            <p style={{opacity: 0.7, marginBottom: 0}}>Waiting for ESP to power on and connect to Wi-Fi...</p>
          </div>
        </div>
      );
    }

    const tds = sensorData.tdsValue || 0;
    let tdsQuality = "";
    let tdsClass = "status";

    if (tds <= 50) {
        tdsQuality = "EXCELLENT";
    } else if (tds <= 150) {
        tdsQuality = "IDEAL";
    } else if (tds <= 300) {
        tdsQuality = "GOOD";
    } else if (tds <= 500) {
        tdsQuality = "FAIR";
        tdsClass = "status warning";
    } else {
        tdsQuality = "POOR / UNACCEPTABLE";
        tdsClass = "status dirty";
    }

    const turbVoltage = sensorData.turbidityVoltage || 0;
    const turbClass = sensorData.waterStatus === 'CLEAR' ? 'status' : 'status dirty';

    let finalQuality = "";
    let finalClass = "status";

    if (sensorData.waterStatus === 'DIRTY') {
        finalQuality = "UNSAFE (DIRTY WATER)";
        finalClass = "status dirty";
    } else {
        if (tds <= 50) {
            finalQuality = "ULTRA-PURE";
        } else if (tds <= 150) {
            finalQuality = "IDEAL (BEST TASTE)";
        } else if (tds <= 300) {
            finalQuality = "GOOD / ACCEPTABLE";
        } else if (tds <= 500) {
            finalQuality = "FAIR (MINERAL-HEAVY)";
            finalClass = "status warning";
        } else {
            finalQuality = "POOR (UNACCEPTABLE)";
            finalClass = "status dirty";
        }
    }

    return (
      <div className="node-container" style={{background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '15px', marginBottom: '20px'}}>
        <h2 style={{color: '#fff', marginBottom: '15px', marginTop: 0}}>{title}</h2>
        <div className="nodes-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
          <div className="card" style={{margin: 0}}>
              <h3>TDS Level</h3>
              <div className="value">{tds.toFixed(2)}<span className="unit">ppm</span></div>
              <div className={tdsClass}>{tdsQuality}</div>
          </div>
          
          <div className="card" style={{margin: 0}}>
              <h3>Turbidity</h3>
              <div className="value">{turbVoltage.toFixed(2)}<span className="unit">V</span></div>
              <div className={turbClass}>{sensorData.waterStatus || "UNKNOWN"}</div>
          </div>

          <div className="card final-card" style={{margin: 0}}>
              <h3>Overall Quality</h3>
              <div className={finalClass} style={{fontSize: "1.1rem"}}>{finalQuality}</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="dashboard" style={{maxWidth: "900px"}}>
      <div className="header-flex">
          <h1>Welcome, {user.name}</h1>
          <button onClick={handleLogout} className="logout-btn">Logout</button>
      </div>
      
      <div className="update-timer">
          {countdown > 0 ? `Next update in: ` : ''} 
          <span>{countdown > 0 ? `${countdown}s` : 'Updating...'}</span>
      </div>

      <div className="card" style={{ background: valveState ? 'rgba(46, 204, 113, 0.2)' : 'rgba(231, 76, 60, 0.2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <div>
            <h3 style={{ margin: 0 }}>🏠 Your Main Water Valve</h3>
            <p style={{ margin: 0, opacity: 0.8, fontSize: '0.9rem' }}>Controls water supply to your home</p>
          </div>
          <button 
            onClick={toggleValve} 
            style={{
              padding: '10px 30px', 
              fontSize: '1.2rem', 
              fontWeight: 'bold', 
              border: 'none', 
              borderRadius: '8px', 
              cursor: 'pointer',
              background: valveState ? '#2ecc71' : '#e74c3c',
              color: 'white',
              boxShadow: '0 4px 15px rgba(0,0,0,0.2)'
            }}
          >
            {valveState ? "OPEN" : "CLOSED"}
          </button>
      </div>

      {renderQualityCard(govData, "🏛️ Government Supplied Water (Main Node)")}
      {renderQualityCard(data, "🏠 Your Home Water Quality (Tap)")}

    </div>
  );
};

export default ConsumerDashboard;
