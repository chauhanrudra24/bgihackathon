import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ref, onValue, set } from 'firebase/database';
import { db } from '../firebase';

const ConsumerDashboard = () => {
  const [govData, setGovData] = useState(null);
  const [myNodeData, setMyNodeData] = useState(null);
  const [valveData, setValveData] = useState({ gov: true, user: true });
  const [account, setAccount] = useState({ balance: 500 });
  const [ratePerLitre, setRatePerLitre] = useState(0.5);
  const [errorMsg, setErrorMsg] = useState('');
  const [showRechargeModal, setShowRechargeModal] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [prevLitres, setPrevLitres] = useState(null);
  
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
    const accountRef = ref(db, `accounts/${nodeId}`);
    
    const unsubscribeGovSensor = onValue(govSensorRef, (snapshot) => {
      const govNewData = snapshot.val();
      if (govNewData) {
        setGovData(govNewData);
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

    const unsubscribeAccount = onValue(accountRef, (snapshot) => {
      const acctData = snapshot.val();
      if (acctData) {
        setAccount(acctData);
      } else {
        // Initialize account with default balance if not exists
        set(ref(db, `accounts/${nodeId}`), { balance: 500, blocked: false, theftFlagged: false });
      }
    });

    // Listen for admin-set water rate
    const settingsRef = ref(db, 'settings/pricePerLiter');
    const unsubscribeSettings = onValue(settingsRef, (snapshot) => {
      const rate = snapshot.val();
      if (rate && rate > 0) setRatePerLitre(rate);
    });

    return () => {
      unsubscribeGovSensor();
      unsubscribeMyNode();
      unsubscribeValve();
      unsubscribeAccount();
      unsubscribeSettings();
    };
  }, [nodeId, navigate, user.role, user.nodeId]);

  // ===== AUTO DEDUCT BALANCE BASED ON USAGE =====
  useEffect(() => {
    if (!myNodeData || account.balance === undefined) return;

    const currentLitres = myNodeData.totalLitres || 0;
    
    if (prevLitres !== null && currentLitres > prevLitres) {
      const litresUsed = currentLitres - prevLitres;
      const cost = litresUsed * ratePerLitre;
      const newBalance = Math.max(0, account.balance - cost);
      
      if (newBalance !== account.balance) {
        set(ref(db, `accounts/${nodeId}/balance`), parseFloat(newBalance.toFixed(2)));
      }

      // Auto-block if balance hits zero
      if (newBalance <= 0 && !account.blocked) {
        set(ref(db, `accounts/${nodeId}/blocked`), true);
        set(ref(db, `valves/${nodeId}/gov`), false);
      }
    } else if (prevLitres !== null && currentLitres < prevLitres) {
      // System reset detected: Sync prevLitres to current (0) without billing
      console.log("Reset detected, syncing billing baseline.");
    }
    
    setPrevLitres(currentLitres);
  }, [myNodeData?.totalLitres]);


  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/');
  };

  const toggleValve = () => {
    if (!valveData.gov || account.blocked || account.theftFlagged || account.balance <= 0) return;
    set(ref(db, `valves/${nodeId}/user`), !valveData.user);
  };

  // ===== SIMULATED RAZORPAY PAYMENT =====
  const handleRecharge = () => {
    const amount = parseFloat(rechargeAmount);
    if (!amount || amount <= 0) return;

    setPaymentProcessing(true);

    // Simulate Razorpay payment gateway flow (2 second delay)
    setTimeout(() => {
      const newBalance = (account.balance || 0) + amount;
      set(ref(db, `accounts/${nodeId}/balance`), parseFloat(newBalance.toFixed(2)));
      
      // If was blocked due to zero balance, unblock
      if (account.blocked && !account.theftFlagged) {
        set(ref(db, `accounts/${nodeId}/blocked`), false);
        set(ref(db, `valves/${nodeId}/gov`), true);
      }

      setPaymentProcessing(false);
      setPaymentSuccess(true);
      setRechargeAmount('');
      
      // Auto-close success modal after 2 seconds
      setTimeout(() => {
        setPaymentSuccess(false);
        setShowRechargeModal(false);
      }, 2000);
    }, 2000);
  };

  const isNodeOnline = (timestamp) => {
    if (!timestamp) return false;
    // 60 second threshold + drift tolerance
    return Math.abs(Date.now() - timestamp) < 60000;
  };

  const myNodeOnline = isNodeOnline(myNodeData?.lastSeen);
  const tamperDetected = myNodeData?.tamperDetected || false;
  const balance = account?.balance ?? 500;
  const isBlocked = account?.blocked || account?.theftFlagged || balance <= 0;

  // Water quality from gov node
  const renderQualityCard = (sensorData, title) => {
    if (!sensorData) return null;
    const online = isNodeOnline(sensorData?.lastSeen);

    const tdsConnected = sensorData.tdsConnected === true;
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

    const turbConnected = sensorData.turbidityConnected === true;
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
          <span className={`status ${online ? '' : 'offline'}`}>
            {online ? '● ONLINE' : `🔌 OFFLINE (Seen ${sensorData.lastSeen ? new Date(sensorData.lastSeen).toLocaleTimeString() : 'Never'})`}
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

        {/* ===== PREPAID BALANCE CARD ===== */}
        <div className="balance-card" style={{
          background: balance <= 0 
            ? 'linear-gradient(135deg, #ef4444, #dc2626)' 
            : balance <= 100 
              ? 'linear-gradient(135deg, #f59e0b, #d97706)' 
              : 'linear-gradient(135deg, var(--primary), var(--accent))'
        }}>
          <div className="balance-info">
            <h3>💳 Prepaid Water Balance</h3>
            <div className="balance-value">₹{balance.toFixed(2)}</div>
            <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.8 }}>
              Rate: ₹{ratePerLitre}/litre | Usage: {(myNodeData?.totalLitres || 0).toFixed(1)}L
            </p>
          </div>
          <button className="recharge-btn" onClick={() => setShowRechargeModal(true)}>
            ⚡ Recharge
          </button>
        </div>

        {/* Tamper Alert Banner */}
        {tamperDetected && myNodeOnline && (
          <div className="theft-banner alert" style={{ marginBottom: '2rem' }}>
            <div className="theft-banner-icon">🚨</div>
            <div className="theft-banner-content">
              <h3>TAMPER ALERT</h3>
              <p>Water flow detected while valve is CLOSED or DEVICE SHAKING/REMOVAL detected. Check your meter for interference.</p>
            </div>
          </div>
        )}

        {/* Theft Flagged Alert */}
        {account.theftFlagged && (
          <div className="theft-banner alert" style={{ marginBottom: '2rem' }}>
            <div className="theft-banner-icon">🕵️</div>
            <div className="theft-banner-content">
              <h3>ACCOUNT FLAGGED — SUPPLY BLOCKED</h3>
              <p>Your connection has been flagged for suspicious activity. Please contact the Jal Board office to verify and restore your supply.</p>
            </div>
          </div>
        )}

        {/* Zero Balance Alert */}
        {balance <= 0 && !account.theftFlagged && (
          <div className="theft-banner suspicious" style={{ marginBottom: '2rem' }}>
            <div className="theft-banner-icon">💳</div>
            <div className="theft-banner-content">
              <h3>ZERO BALANCE — SUPPLY SUSPENDED</h3>
              <p>Your prepaid balance is ₹0. Please recharge your account to restore water supply. Click the "Recharge" button above.</p>
            </div>
          </div>
        )}

        {/* Gov Supply Alert */}
        {!valveData.gov && myNodeOnline && !account.theftFlagged && balance > 0 && (
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
            <span className={`status ${myNodeOnline ? (isBlocked ? 'dirty' : (!valveData.gov ? 'warning' : '')) : 'offline'}`}>
              {myNodeOnline ? (isBlocked ? '🔒 BLOCKED' : (!valveData.gov ? '🛑 CUT' : '● ONLINE')) : 'OFFLINE'}
            </span>
          </div>
          
          {/* Main Control Card */}
          <div className="card" style={{ 
            marginBottom: '1.5rem', 
            background: isBlocked ? 'var(--bg-color)' : !valveData.gov ? 'var(--bg-color)' : 'linear-gradient(135deg, var(--surface-color), var(--primary-light))', 
            border: isBlocked ? '2px solid var(--danger)' : !valveData.gov ? '1px solid var(--border-color)' : '1px solid var(--primary)',
            opacity: isBlocked || !valveData.gov ? 0.8 : 1
          }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="valve-info">
                  <h3 style={{ color: isBlocked ? 'var(--danger)' : !valveData.gov ? 'var(--text-muted)' : 'var(--primary)' }}>
                    {isBlocked ? '🔒 Supply Blocked' : !valveData.gov ? 'Supply Cut' : 'Main Valve'}
                  </h3>
                  <p style={{ fontSize: '0.8rem' }}>
                    {account.theftFlagged ? 'Flagged for suspicious activity' : account.blocked ? 'Blocked by authority' : balance <= 0 ? 'Insufficient balance' : !valveData.gov ? 'Government Override Active' : (myNodeOnline ? 'Active Control' : 'Device Offline')}
                  </p>
                </div>
                <button 
                  disabled={!myNodeOnline || !valveData.gov || isBlocked}
                  onClick={toggleValve} 
                  className={`valve-btn ${valveData.user ? 'open' : 'closed'}`}
                  style={{ padding: '0.6rem 1.5rem' }}
                >
                  {isBlocked ? "LOCKED" : !valveData.gov ? "LOCKED" : (valveData.user ? "ON" : "OFF")}
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

              <div className="card">
                <h3>Est. Cost</h3>
                <div className="value" style={{ fontSize: '1.8rem' }}>
                  ₹{((myNodeData?.totalLitres || 0) * ratePerLitre).toFixed(2)}
                </div>
                <div className="status" style={{ fontSize: '0.6rem' }}>THIS SESSION</div>
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
          {govData ? renderQualityCard(govData, "Rau Pumping Station (BGI Indore Area)") : (
            <div className="card" style={{ textAlign: 'center', padding: '2rem', background: 'var(--bg-color)' }}>
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Connecting to city supply data...</p>
            </div>
          )}
        </section>


        {/* ===== RAZORPAY RECHARGE MODAL ===== */}
        {showRechargeModal && (
          <div className="payment-modal" onClick={(e) => { if (e.target === e.currentTarget && !paymentProcessing) setShowRechargeModal(false); }}>
            <div className="modal-content">
              {paymentSuccess ? (
                <>
                  <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✅</div>
                  <h2 style={{ color: 'var(--success)' }}>Payment Successful!</h2>
                  <p style={{ color: 'var(--text-secondary)' }}>Your balance has been updated.</p>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                    <h2 style={{ margin: 0 }}>⚡ Recharge via Razorpay</h2>
                    {!paymentProcessing && (
                      <button onClick={() => setShowRechargeModal(false)} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>
                    )}
                  </div>
                  
                  <div style={{ background: 'var(--bg-color)', padding: '1rem', borderRadius: 'var(--radius-md)', marginBottom: '1.5rem', textAlign: 'left' }}>
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Current Balance</p>
                    <p style={{ margin: '0.25rem 0 0', fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)' }}>₹{balance.toFixed(2)}</p>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                    {[50, 100, 200, 500].map(amt => (
                      <button key={amt} onClick={() => setRechargeAmount(String(amt))} 
                        style={{ 
                          flex: 1, padding: '0.5rem', border: rechargeAmount === String(amt) ? '2px solid var(--primary)' : '1px solid var(--border-color)', 
                          borderRadius: 'var(--radius-md)', background: rechargeAmount === String(amt) ? 'var(--primary-light)' : 'white',
                          fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', minWidth: '60px'
                        }}>
                        ₹{amt}
                      </button>
                    ))}
                  </div>

                  <input 
                    type="number"
                    className="amount-input"
                    placeholder="Enter amount (₹)"
                    value={rechargeAmount}
                    onChange={(e) => setRechargeAmount(e.target.value)}
                    disabled={paymentProcessing}
                    min="1"
                  />

                  <button 
                    className="pay-btn" 
                    onClick={handleRecharge}
                    disabled={paymentProcessing || !rechargeAmount || parseFloat(rechargeAmount) <= 0}
                    style={{ 
                      opacity: paymentProcessing || !rechargeAmount ? 0.6 : 1,
                      background: paymentProcessing ? 'var(--text-muted)' : 'var(--primary)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem'
                    }}
                  >
                    {paymentProcessing ? (
                      <>
                        <span className="flow-dot" style={{ background: 'white' }}></span>
                        Processing via Razorpay...
                      </>
                    ) : (
                      `Pay ₹${rechargeAmount || 0} via Razorpay`
                    )}
                  </button>
                  
                  <p style={{ marginTop: '1rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    🔒 Secured by Razorpay | Simulated for Demo
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ConsumerDashboard;
