import { useEffect, useState, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ref, onValue, set, update, push } from 'firebase/database';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, firestore } from '../firebase';
import toast from 'react-hot-toast';

const formatVolume = (litres) => {
  const val = litres || 0;
  if (val < 1) {
    return `${(val * 1000).toFixed(0)} ml`;
  }
  return `${val.toFixed(3)} L`;
};


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
  const [myRecharges, setMyRecharges] = useState([]);
  const [myUsageLogs, setMyUsageLogs] = useState([]);
  const lastSyncedBalanceRef = useRef(0);
  
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
        const initial = { balance: 500, blocked: false, theftFlagged: false };
        set(ref(db, `accounts/${nodeId}`), initial);
        syncBalanceToFirestore(500);
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

  // Helper to sync balance to Firestore for persistent history/last state
  const syncBalanceToFirestore = async (newBalance) => {
    try {
      await setDoc(doc(firestore, "consumerBalances", nodeId), {
        nodeId,
        consumerName: user.name,
        balance: parseFloat(newBalance.toFixed(2)),
        lastUpdated: serverTimestamp()
      }, { merge: true });
      lastSyncedBalanceRef.current = newBalance;
    } catch (err) {
      console.error("Firestore sync error:", err);
    }
  };

  useEffect(() => {
    if (!nodeId) return;

    const rechargeLogsRef = ref(db, 'rechargeLogs');
    const unsubscribeRecharges = onValue(rechargeLogsRef, (snapshot) => {
      const logs = snapshot.val();
      if (logs) {
        const filtered = Object.entries(logs)
          .map(([id, val]) => ({ id, ...val }))
          .filter(l => l.nodeId === nodeId)
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setMyRecharges(filtered);
      } else {
        setMyRecharges([]);
      }
    });

    const usageLogsRef = ref(db, `usageHistory/${nodeId}`);
    const unsubscribeUsage = onValue(usageLogsRef, (snapshot) => {
      const logs = snapshot.val();
      if (logs) {
        const logsArray = Object.entries(logs)
          .map(([id, val]) => ({ id, ...val }))
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setMyUsageLogs(logsArray);
      } else {
        setMyUsageLogs([]);
      }
    });

    return () => {
      unsubscribeRecharges();
      unsubscribeUsage();
    };
  }, [nodeId]);

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
        
        // Log usage history
        push(ref(db, `usageHistory/${nodeId}`), {
          timestamp: Date.now(),
          litresUsed: parseFloat(litresUsed.toFixed(3)),
          cost: parseFloat(cost.toFixed(2)),
          remainingBalance: parseFloat(newBalance.toFixed(2))
        });

        // Sync to Firestore periodically or on significant change
        // Throttled to avoid spamming Firestore on every few millilitres
        if (Math.abs(newBalance - lastSyncedBalanceRef.current) > 1.0) {
           syncBalanceToFirestore(newBalance);
        }
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


  const triggerEmergency = async () => {
    const isActive = myNodeData?.emergencyActive || false;
    const action = isActive ? "Stopping" : "Activating";
    
    const toastId = toast.loading(`${action} SOS Emergency Water...`);
    
    try {
      // Optimistic update for myNodeData (though it's usually synced from FB)
      setMyNodeData(prev => ({ ...prev, emergencyActive: !isActive }));
      
      if (!isActive) {
        // Firmware listens for `triggerEmergency` to turn SOS on, and `sosActive=false` to force it off.
        await set(ref(db, `commands/${nodeId}/triggerEmergency`), true);
        await set(ref(db, `commands/${nodeId}/sosActive`), true);
      } else {
        await set(ref(db, `commands/${nodeId}/sosActive`), false);
      }
      toast.success(`SOS ${!isActive ? 'Activated' : 'Deactivated'}`, { id: toastId });
    } catch (error) {
      toast.error("Failed to trigger SOS", { id: toastId });
      // Revert if needed (Firebase sync will handle it usually)
    }
  };

  const handleLogout = async () => {
    // Final balance sync to Firestore on logout
    if (account.balance !== undefined) {
      await syncBalanceToFirestore(account.balance);
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/');
  };

  const toggleValve = async () => {
    if (!valveData.gov || account.blocked || account.theftFlagged || account.balance <= 0) {
      toast.error("Valve is locked by authorities or low balance");
      return;
    }

    const newState = !valveData.user;
    const toastId = toast.loading(newState ? "Opening valve..." : "Closing valve...");

    // Optimistic UI
    const previousState = valveData.user;
    setValveData(prev => ({ ...prev, user: newState }));

    try {
      await set(ref(db, `valves/${nodeId}/user`), newState);
      toast.success(`Valve ${newState ? 'Opened' : 'Closed'}`, { id: toastId });
    } catch (error) {
      setValveData(prev => ({ ...prev, user: previousState }));
      toast.error("Failed to update valve", { id: toastId });
    }
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
      syncBalanceToFirestore(newBalance);
      
      // If was blocked due to zero balance, unblock
      if (account.blocked && !account.theftFlagged) {
        set(ref(db, `accounts/${nodeId}/blocked`), false);
        set(ref(db, `valves/${nodeId}/gov`), true);
      }

      // Add recharge log
      const logRef = ref(db, 'rechargeLogs');
      push(logRef, {
        nodeId,
        consumerName: user.name,
        amount,
        timestamp: Date.now(),
        status: 'SUCCESS'
      });

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

  const isNodeOnline = (lastSeen) => {
    if (!lastSeen) return false;
    const now = Date.now();
    // Increased to 45s to provide a larger buffer for network latency
    return (now - lastSeen) < 45000;
  };

  const myNodeOnline = isNodeOnline(myNodeData?.lastSeen);
  const tamperDetected = myNodeData?.tamperDetected || false;
  const balance = account?.balance ?? 500;
  const emergencyActive = myNodeData?.emergencyActive || false;
  const emergencyValue = Number(myNodeData?.emergencyValue) || 0;
  const isBlocked = (account?.blocked || account?.theftFlagged || balance <= 0) && !emergencyActive;

  // Water quality from gov node
  const renderQualityCard = (sensorData, title) => {
    if (!sensorData) return null;
    const online = isNodeOnline(sensorData?.lastSeen);
    const tdsConnected = sensorData.tdsConnected === true;
    const tdsValue = Number(sensorData.tdsValue || 0);
    const turbConnected = sensorData.turbidityConnected === true;
    const turbVoltage = Number(sensorData.turbidityVoltage || 0);
    const waterStatus = sensorData.waterStatus || "UNKNOWN";

    let tdsQuality = tdsConnected ? "GOOD" : "NOT CONNECTED";
    let tdsClass = tdsConnected ? "status" : "status offline";

    if (tdsConnected) {
      if (tdsValue <= 50) tdsQuality = "EXCELLENT";
      else if (tdsValue <= 150) tdsQuality = "IDEAL";
      else if (tdsValue <= 300) tdsQuality = "GOOD";
      else if (tdsValue <= 500) {
          tdsQuality = "FAIR";
          tdsClass = "status warning";
      } else {
          tdsQuality = "POOR";
          tdsClass = "status dirty";
      }
    }

    const turbStatus = turbConnected ? waterStatus : "NOT CONNECTED";
    let turbClass = "status";
    if (!turbConnected) turbClass = "status offline";
    else if (waterStatus === 'DIRTY') turbClass = "status dirty";

    let finalQuality = "ACCEPTABLE";
    let finalClass = "status";

    if (!turbConnected || !tdsConnected) {
      finalQuality = "SENSOR ERROR";
      finalClass = "status warning";
    } else if (turbStatus === 'NOT CONNECTED' || tdsQuality === 'NOT CONNECTED') {
      finalQuality = "SENSOR DISCONNECTED";
      finalClass = "status offline";
    } else if (waterStatus === 'DIRTY') {
        finalQuality = "UNSAFE (DIRTY)";
        finalClass = "status dirty";
    } else {
        if (tdsValue <= 150) finalQuality = "ULTRA-PURE";
        else if (tdsValue <= 300) finalQuality = "GOOD QUALITY";
        else if (tdsValue <= 500) {
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
                {tdsValue > 0 ? tdsValue.toFixed(0) : "--"}
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
    <div className={`dashboard-container ${emergencyActive ? 'emergency-active-dashboard' : ''}`}>
      <div className="dashboard">
        <header className="header-flex" style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Good Morning,</p>
              <h1 style={{ fontSize: '1.5rem' }}>{user.name}</h1>
            </div>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <button 
                onClick={() => {
                  toast.promise(
                    new Promise((resolve) => setTimeout(resolve, 1000)),
                    {
                      loading: 'Syncing with grid...',
                      success: 'System Synced',
                      error: 'Sync failed',
                    }
                  ).then(() => {
                    // Reactive update via Firebase onValue
                  });
                }} 
                className="logout-btn"
                style={{ background: 'white', color: 'var(--primary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                🔄 Sync
              </button>
              <button onClick={handleLogout} className="logout-btn">Logout</button>
            </div>
        </header>

        {/* ===== PREPAID BALANCE CARD ===== */}
        <div className="balance-card" style={{
          background: balance <= 0 
            ? 'linear-gradient(135deg, #ef4444, #dc2626)' 
            : balance <= 100 
              ? 'linear-gradient(135deg, #f59e0b, #d97706)' 
              : 'linear-gradient(135deg, var(--primary), var(--accent))',
          padding: '2rem',
          borderRadius: 'var(--radius-lg)',
          color: 'white',
          marginBottom: '2rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="balance-info">
              <h3 style={{ margin: 0, opacity: 0.9, fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>💳 Current Balance</h3>
              <div className="balance-value" style={{ fontSize: '3rem', fontWeight: 800, margin: '0.5rem 0' }}>₹{balance.toFixed(2)}</div>
              <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.8 }}>
                Billing Rate: <strong>₹{ratePerLitre}/L</strong>
              </p>
            </div>
            <button className="recharge-btn" onClick={() => setShowRechargeModal(true)} style={{ 
              background: 'white', 
              color: balance <= 100 ? 'var(--warning)' : 'var(--primary)',
              padding: '0.75rem 1.5rem',
              borderRadius: 'var(--radius-md)',
              fontWeight: 700,
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
            }}>
              ⚡ Recharge Now
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: '1.5rem' }}>
            <div style={{ background: 'rgba(255,255,255,0.1)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
              <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.8, textTransform: 'uppercase' }}>Today's Usage</p>
              <p style={{ margin: '0.25rem 0 0 0', fontSize: '1.25rem', fontWeight: 700 }}>{formatVolume(myNodeData?.totalLitres || 0)}</p>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.1)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
              <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.8, textTransform: 'uppercase' }}>Monthly Usage (Est.)</p>
              <p style={{ margin: '0.25rem 0 0 0', fontSize: '1.25rem', fontWeight: 700 }}>{formatVolume((myNodeData?.totalLitres || 0) * 30.5)}</p>
            </div>
          </div>
        </div>

        {/* Offline Alert Banner */}
        {!myNodeOnline && (
          <div className="theft-banner alert animate-fade-in" style={{ 
            marginBottom: '2rem', 
            background: 'linear-gradient(135deg, #4b5563, #1f2937)',
            animation: 'fadeIn 0.5s ease-in'
          }}>
            <div className="theft-banner-icon">🔌</div>
            <div className="theft-banner-content">
              <h3>HARDWARE OFFLINE</h3>
              <p>Connection to your smart meter has been lost. Controls are disabled until the device reconnects to Wi-Fi.</p>
            </div>
          </div>
        )}

        {/* SOS Warning Banner */}
        {emergencyActive && myNodeOnline && (
          <div className="theft-banner alert" style={{ marginBottom: '2rem', background: 'linear-gradient(135deg, #ef4444, #b91c1c)' }}>
            <div className="theft-banner-icon">🆘</div>
            <div className="theft-banner-content">
              <h3>EMERGENCY SUPPLY ACTIVE</h3>
              <p>You have manually triggered the emergency override. Normal billing is suspended and premium emergency supply is active.</p>
            </div>
          </div>
        )}
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


        {/* Low Balance Alert */}
        {balance > 0 && balance <= 100 && (
          <div className="theft-banner suspicious animate-pulse" style={{ marginBottom: '2rem', border: '2px solid var(--warning)' }}>
            <div className="theft-banner-icon">⚠️</div>
            <div className="theft-banner-content">
              <h3 style={{ color: '#d97706' }}>LOW BALANCE ALERT</h3>
              <p>Your balance is low (₹{balance.toFixed(2)}). Please recharge soon to avoid water supply interruption.</p>
            </div>
          </div>
        )}

        {/* Zero Balance Alert */}
        {balance <= 0 && !account.theftFlagged && !emergencyActive && (
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
            <span className={`status ${myNodeOnline ? (isBlocked ? 'dirty' : (!valveData.gov ? 'warning' : '')) : 'offline'}`} style={{ transition: 'all 0.5s ease' }}>
              {myNodeOnline ? (isBlocked ? '🔒 BLOCKED' : (!valveData.gov ? '🛑 CUT' : '● ONLINE')) : 'OFFLINE'}
            </span>
          </div>
          
          {/* Main Control Card */}
          <div className="card" style={{ 
            marginBottom: '1.5rem', 
            background: isBlocked ? 'var(--bg-color)' : !valveData.gov ? 'var(--bg-color)' : 'linear-gradient(135deg, var(--surface-color), var(--primary-light))', 
            border: isBlocked ? '2px solid var(--danger)' : !valveData.gov ? '1px solid var(--border-color)' : '1px solid var(--primary)'
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
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button 
                    onClick={triggerEmergency}
                    className={`emergency-btn ${emergencyActive ? 'active' : ''}`}
                    style={{ 
                      background: emergencyActive ? 'var(--danger)' : '#fee2e2', 
                      color: emergencyActive ? 'white' : 'var(--danger)',
                      border: 'none', padding: '0.6rem 1rem', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer', fontSize: '0.8rem'
                    }}
                  >
                    {emergencyActive ? "🛑 STOP SOS" : "🆘 SOS"}
                  </button>
                  <button 
                    disabled={!myNodeOnline || !valveData.gov || isBlocked}
                    onClick={toggleValve} 
                    className={`valve-btn ${valveData.user ? 'open' : 'closed'}`}
                    style={{ padding: '0.6rem 1.5rem' }}
                  >
                    {isBlocked ? "LOCKED" : !valveData.gov ? "LOCKED" : (valveData.user ? "CLOSE" : "OPEN")}
                  </button>
                </div>
              </div>
          </div>

          {/* Flow Data Cards — ALWAYS visible when online */}
          {myNodeOnline ? (
            <div className="nodes-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
              {/* Emergency SOS Card (shown alongside flow data, not replacing it) */}
              {emergencyActive && (
                <div className="card" style={{ gridColumn: '1 / -1', background: 'rgba(239, 68, 68, 0.05)', border: '2px dashed #ef4444' }}>
                   <div style={{ textAlign: 'center', padding: '1rem' }}>
                      <h3 style={{ color: '#ef4444', margin: 0 }}>SOS WATER USED</h3>
                      <div className="value" style={{ fontSize: '2.5rem', color: '#ef4444' }}>
                        {user.hasSensor !== false ? formatVolume(myNodeData?.emergencyLitres || 0) : `${Math.floor(emergencyValue)} sec`}
                      </div>

                   </div>
                </div>
              )}

              {user.hasSensor !== false && (
                <>
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

                  <div className="card" style={{ border: '1px solid var(--primary)', background: 'var(--primary-light)' }}>
                    <h3 style={{ color: 'var(--primary)' }}>Normal Billed</h3>
                    <div className="value" style={{ fontSize: '1.8rem' }}>
                      {formatVolume(myNodeData?.totalLitres)}
                    </div>
                    <div className="status" style={{ fontSize: '0.6rem' }}>SESSION USAGE</div>
                  </div>


                  <div className="card" style={{ border: '1px solid var(--danger)', background: 'var(--danger-light)' }}>
                    <h3 style={{ color: 'var(--danger)' }}>SOS Consumption</h3>
                    <div className="value" style={{ fontSize: '1.8rem', color: 'var(--danger)' }}>
                      {formatVolume(myNodeData?.emergencyLitresTotal || (myNodeData?.totalLitres - myNodeData?.billedLitres))}
                    </div>
                    <div className="status" style={{ fontSize: '0.6rem', background: 'var(--danger)', color: 'white' }}>FREE / SOS</div>
                  </div>

                </>
              )}

              <div className="card">
                <h3>Est. Cost</h3>
                <div className="value" style={{ fontSize: '1.8rem' }}>
                  ₹{((myNodeData?.totalLitres || 0) * ratePerLitre).toFixed(2)}
                </div>
                <div className="status" style={{ fontSize: '0.6rem' }}>{user.hasSensor !== false ? 'THIS SESSION' : 'FIXED CHARGES'}</div>
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

        {/* Usage & Recharge History Section */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', marginTop: '2.5rem' }}>
          {/* Usage History */}
          <div className="card">
            <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              📊 Usage History
            </h3>
            <div className="gov-table-container" style={{ maxHeight: '300px', overflowY: 'auto' }}>
              <table className="gov-table" style={{ width: '100%' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                    <th style={{ padding: '0.75rem', fontSize: '0.75rem' }}>Date/Time</th>
                    <th style={{ padding: '0.75rem', fontSize: '0.75rem' }}>Usage</th>
                    <th style={{ padding: '0.75rem', fontSize: '0.75rem' }}>Deducted</th>
                  </tr>
                </thead>
                <tbody>
                  {myUsageLogs.length === 0 ? (
                    <tr><td colSpan="3" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>No usage recorded yet.</td></tr>
                  ) : (
                    myUsageLogs.slice(0, 50).map(log => (
                      <tr key={log.id} style={{ borderBottom: '1px solid var(--border-color)', fontSize: '0.85rem' }}>
                        <td style={{ padding: '0.75rem' }}>{new Date(log.timestamp).toLocaleString()}</td>
                        <td style={{ padding: '0.75rem', fontWeight: 600 }}>{formatVolume(log.litresUsed)}</td>
                        <td style={{ padding: '0.75rem', color: 'var(--danger)', fontWeight: 600 }}>-₹{log.cost.toFixed(2)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recharge Logs */}
          <div className="card">
            <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              📜 Recharge History
            </h3>
            <div className="gov-table-container" style={{ maxHeight: '300px', overflowY: 'auto' }}>
              <table className="gov-table" style={{ width: '100%' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                    <th style={{ padding: '0.75rem', fontSize: '0.75rem' }}>Date/Time</th>
                    <th style={{ padding: '0.75rem', fontSize: '0.75rem' }}>Amount</th>
                    <th style={{ padding: '0.75rem', fontSize: '0.75rem' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {myRecharges.length === 0 ? (
                    <tr><td colSpan="3" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>No recharges yet.</td></tr>
                  ) : (
                    myRecharges.map(log => (
                      <tr key={log.id} style={{ borderBottom: '1px solid var(--border-color)', fontSize: '0.85rem' }}>
                        <td style={{ padding: '0.75rem' }}>{new Date(log.timestamp).toLocaleString()}</td>
                        <td style={{ padding: '0.75rem', color: 'var(--success)', fontWeight: 700 }}>+₹{log.amount.toFixed(2)}</td>
                        <td style={{ padding: '0.75rem' }}>
                          <span className="status" style={{ fontSize: '0.6rem' }}>{log.status}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>


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
