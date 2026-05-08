import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import axios from 'axios';

const Dashboard = () => {
  const [data, setData] = useState(null);
  const [countdown, setCountdown] = useState(5);
  const navigate = useNavigate();

  useEffect(() => {
    // Fetch initial data
    axios.get(`${import.meta.env.VITE_API_URL}/api/sensor/latest`)
      .then(res => {
        if (res.data) setData(res.data);
      })
      .catch(err => console.error(err));

    // Connect to Socket
    const socket = io(import.meta.env.VITE_API_URL);

    socket.on('sensor-update', (newData) => {
      setData(newData);
      setCountdown(5);
    });

    return () => socket.disconnect();
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

  if (!data) return <div className="dashboard"><h2>Waiting for ESP32 connection...</h2></div>;

  const tds = data.tdsValue;
  let tdsQuality = "";
  let tdsClass = "status";

  if (tds <= 50) {
    tdsQuality = "EXCELLENT / ULTRA-PURE";
  } else if (tds <= 150) {
    tdsQuality = "IDEAL";
  } else if (tds <= 300) {
    tdsQuality = "GOOD / ACCEPTABLE";
  } else if (tds <= 500) {
    tdsQuality = "FAIR";
    tdsClass = "status warning";
  } else {
    tdsQuality = "POOR / UNACCEPTABLE";
    tdsClass = "status dirty";
  }

  const turbClass = data.waterStatus === 'CLEAR' ? 'status' : 'status dirty';

  let finalQuality = "";
  let finalClass = "status";

  if (data.waterStatus === 'DIRTY') {
    finalQuality = "UNSAFE (DIRTY WATER)";
    finalClass = "status dirty";
  } else {
    if (tds <= 50) {
      finalQuality = "ULTRA-PURE (VERY FEW MINERALS)";
    } else if (tds <= 150) {
      finalQuality = "IDEAL (BEST TASTE & MINERAL BALANCE)";
    } else if (tds <= 300) {
      finalQuality = "GOOD / ACCEPTABLE (PLEASANT TO NORMAL TASTE)";
    } else if (tds <= 500) {
      finalQuality = "FAIR (NOTICEABLY HIGHER MINERAL TASTE)";
      finalClass = "status warning";
    } else {
      finalQuality = "POOR / UNACCEPTABLE (HARD, MINERAL-HEAVY)";
      finalClass = "status dirty";
    }
  }

  const fontSize = finalQuality.length > 25 ? "1.1rem" : "1.5rem";

  return (
    <div className="dashboard">
      <div className="header-flex">
        <h1>Government Dashboard</h1>
        <button onClick={handleLogout} className="logout-btn">Logout</button>
      </div>

      <div className="update-timer">
        {countdown > 0 ? `Next update in: ` : ''}
        <span>{countdown > 0 ? `${countdown}s` : 'Updating...'}</span>
      </div>

      <div className="card">
        <h3>TDS Level</h3>
        <div className="value">{tds.toFixed(2)}<span className="unit">ppm</span></div>
        <div className={tdsClass}>{tdsQuality}</div>
      </div>

      <div className="card">
        <h3>Turbidity</h3>
        <div className="value">{data.turbidityVoltage.toFixed(2)}<span className="unit">V</span></div>
        <div className={turbClass}>{data.waterStatus}</div>
      </div>

      <div className="card final-card">
        <h3>Overall Water Quality</h3>
        <div className={finalClass} style={{ fontSize }}>{finalQuality}</div>
      </div>
    </div>
  );
};

export default Dashboard;
