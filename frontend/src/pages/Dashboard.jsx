import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ref, onValue } from 'firebase/database';
import { db } from '../firebase';

const NodeCard = ({ title, nodeData }) => {
  if (!nodeData) return <div className="card"><h3>{title}</h3><p>Waiting for data...</p></div>;

  const tds = nodeData.tdsValue || 0;
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

  const turbVoltage = nodeData.turbidityVoltage || 0;
  const turbClass = nodeData.waterStatus === 'CLEAR' ? 'status' : 'status dirty';

  let finalQuality = "";
  let finalClass = "status";

  if (nodeData.waterStatus === 'DIRTY') {
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
    <div className="node-container">
      <h2 style={{color: '#fff', marginBottom: '15px'}}>{title}</h2>
      <div className="card">
          <h3>TDS Level</h3>
          <div className="value">{tds.toFixed(2)}<span className="unit">ppm</span></div>
          <div className={tdsClass}>{tdsQuality}</div>
      </div>
      
      <div className="card">
          <h3>Turbidity</h3>
          <div className="value">{turbVoltage.toFixed(2)}<span className="unit">V</span></div>
          <div className={turbClass}>{nodeData.waterStatus || "UNKNOWN"}</div>
      </div>

      <div className="card final-card">
          <h3>Overall Quality</h3>
          <div className={finalClass} style={{fontSize: "1.2rem"}}>{finalQuality}</div>
      </div>
    </div>
  );
};

const Dashboard = () => {
  const [data, setData] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [countdown, setCountdown] = useState(5);
  const navigate = useNavigate();

  useEffect(() => {
    // Connect directly to Firebase Realtime Database
    const sensorRef = ref(db, 'sensorData');
    
    const unsubscribe = onValue(sensorRef, (snapshot) => {
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

    return () => unsubscribe();
  }, []);

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
  if (!data) return <div className="dashboard"><h2>Waiting for ESP32/Firebase connection...</h2></div>;

  return (
    <div className="dashboard" style={{maxWidth: "1200px"}}>
      <div className="header-flex">
          <h1>Multi-Node Water Dashboard</h1>
          <button onClick={handleLogout} className="logout-btn">Logout</button>
      </div>
      
      <div className="update-timer" style={{marginBottom: "30px"}}>
          {countdown > 0 ? `Next update in: ` : ''} 
          <span>{countdown > 0 ? `${countdown}s` : 'Updating...'}</span>
      </div>

      <div className="nodes-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '30px' }}>
        <NodeCard title="🏛️ Government Node (ESP32)" nodeData={data.gov_node} />
        <NodeCard title="🏠 Consumer Node 1 (ESP32)" nodeData={data.consumer_node} />
        <NodeCard title="🏠 Consumer Node 2 (ESP8266)" nodeData={data.consumer_node_8266} />
      </div>
    </div>
  );
};

export default Dashboard;
