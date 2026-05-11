import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ref, onValue, set } from 'firebase/database';
import { db } from '../firebase';

const isNodeOnline = (nodeData) => {
  if (!nodeData || !nodeData.lastSeen) return false;
  return (Date.now() - nodeData.lastSeen) < 20000;
};

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

  const tds = nodeData.tdsValue || 0;
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

  const turbVoltage = nodeData.turbidityVoltage || 0;
  const turbClass = nodeData.waterStatus === 'CLEAR' ? 'status' : 'status dirty';

  let finalQuality = "ACCEPTABLE";
  let finalClass = "status";

  if (nodeData.waterStatus === 'DIRTY') {
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
            <div className={turbClass}>{nodeData.waterStatus || "UNKNOWN"}</div>
        </div>

        <div className="card">
            <h3>Overall Quality</h3>
            <div className="value" style={{ fontSize: '1.5rem', margin: '0.75rem 0' }}>{finalQuality}</div>
            <div className={finalClass}>VERIFIED</div>
        </div>
      </div>
    </div>
  );
};

const ValveControlCard = ({ title, valveState, onToggleValve, nodeData }) => {
  const online = isNodeOnline(nodeData);

  return (
    <div className="valve-card" style={{ opacity: online ? 1 : 0.6 }}>
      <div className="valve-info">
        <h3>{title}</h3>
        <p>{online ? 'Government Override Active' : 'Node Offline - Control Disabled'}</p>
      </div>
      <button 
        disabled={!online}
        onClick={onToggleValve} 
        className={`valve-btn ${valveState ? 'open' : 'closed'}`}
      >
        {valveState ? "OPEN" : "CLOSED"}
      </button>
    </div>
  );
};

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

  return (
    <div className="dashboard-container">
      <div className="dashboard">
        <div className="header-flex">
            <h1>💧 Jal Board Quality Monitor</h1>
            <button onClick={handleLogout} className="logout-btn">Logout</button>
        </div>
        
        <div className="update-timer">
            {countdown > 0 ? `Live data sync in ` : ''} 
            <span>{countdown > 0 ? `${countdown}s` : 'Syncing...'}</span>
        </div>

        <div className="main-content">
          <NodeCard 
            title="🏛️ Sector-12 Pumping Station" 
            nodeData={data.gov_node} 
          />

          <div className="node-container" style={{ marginTop: '3rem' }}>
            <h2>🏠 Consumer Supply Control</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1rem' }}>
              <ValveControlCard 
                title="Ramesh Kumar (House 42-B)"
                valveState={valves.consumer_node}
                nodeData={data.consumer_node}
                onToggleValve={() => set(ref(db, `valves/consumer_node`), !valves.consumer_node)}
              />
              
              <ValveControlCard 
                title="Priya Patel (House 104)"
                valveState={valves.consumer_node_8266}
                nodeData={data.consumer_node_8266}
                onToggleValve={() => set(ref(db, `valves/consumer_node_8266`), !valves.consumer_node_8266)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
