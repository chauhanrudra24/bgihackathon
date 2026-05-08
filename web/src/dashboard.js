import { auth, db } from './firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { ref, get, onValue } from 'firebase/database';

const dashboardBody = document.getElementById('dashboardBody');
const logoutBtn = document.getElementById('logoutBtn');

// Route Protection
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // Not logged in
    window.location.href = '/';
    return;
  }
  
  // Verify Admin Role again
  const roleRef = ref(db, `users/${user.uid}/role`);
  const snapshot = await get(roleRef);
  
  if (snapshot.exists() && snapshot.val() === 'admin') {
    // Authorized! Show dashboard
    dashboardBody.style.display = 'flex';
    initDashboard();
  } else {
    // Unauthorized
    await signOut(auth);
    window.location.href = '/';
  }
});

logoutBtn.addEventListener('click', () => {
    signOut(auth);
});

function initDashboard() {
    // References to UI elements
    const tdsEl = document.getElementById('tdsValue');
    const turbidityEl = document.getElementById('turbidityValue');
    const statusEl = document.getElementById('waterStatus');
    const updateTimerEl = document.getElementById('updateTimer');
    const tdsStatusEl = document.getElementById('tdsStatus');
    const finalStatusEl = document.getElementById('finalStatus');

    // Reference to 'sensorData' inside Realtime Database
    const sensorRef = ref(db, 'sensorData');
    
    // Variables for countdown
    let countdownInterval;
    let secondsLeft = 5;

    // Listen for real-time updates via WebSockets
    onValue(sensorRef, (snapshot) => {
        const data = snapshot.val();
        
        if (data) {
            // Remove loading animation
            tdsEl.classList.remove('loading');
            turbidityEl.classList.remove('loading');

            // Reset and start countdown timer
            clearInterval(countdownInterval);
            secondsLeft = 5;
            updateTimerEl.innerHTML = `Next update in: <span>${secondsLeft}s</span>`;
            
            countdownInterval = setInterval(() => {
                secondsLeft--;
                if(secondsLeft > 0) {
                    updateTimerEl.innerHTML = `Next update in: <span>${secondsLeft}s</span>`;
                } else {
                    updateTimerEl.innerHTML = `<span>Updating...</span>`;
                }
            }, 1000);

            // Update DOM elements
            tdsEl.innerHTML = `${parseFloat(data.tdsValue).toFixed(2)}<span class="unit">ppm</span>`;
            turbidityEl.innerHTML = `${parseFloat(data.turbidityVoltage).toFixed(2)}<span class="unit">V</span>`;
            
            // Determine TDS Quality
            const tds = parseFloat(data.tdsValue);
            let tdsQuality = "";
            let tdsClass = "status";

            if (tds <= 50) {
                tdsQuality = "EXCELLENT / ULTRA-PURE";
                tdsClass = "status"; // Green
            } else if (tds <= 150) {
                tdsQuality = "IDEAL";
                tdsClass = "status"; // Green
            } else if (tds <= 300) {
                tdsQuality = "GOOD / ACCEPTABLE";
                tdsClass = "status"; // Green
            } else if (tds <= 500) {
                tdsQuality = "FAIR";
                tdsClass = "status warning"; // Yellow
            } else {
                tdsQuality = "POOR / UNACCEPTABLE";
                tdsClass = "status dirty"; // Red
            }

            tdsStatusEl.innerText = tdsQuality;
            tdsStatusEl.className = tdsClass;

            // Turbidity Quality
            statusEl.innerText = data.waterStatus;
            if (data.waterStatus === 'CLEAR') {
                statusEl.className = 'status'; // Default green
            } else {
                statusEl.className = 'status dirty'; // Red styles
            }

            // Determine Final Overall Quality
            let finalQuality = "";
            let finalClass = "status";

            if (data.waterStatus === 'DIRTY') {
                finalQuality = "UNSAFE (DIRTY WATER)";
                finalClass = "status dirty"; // Red
            } else {
                // Water is CLEAR, so we judge based on TDS
                if (tds <= 50) {
                    finalQuality = "ULTRA-PURE (VERY FEW MINERALS)";
                    finalClass = "status"; // Green
                } else if (tds <= 150) {
                    finalQuality = "IDEAL (BEST TASTE & MINERAL BALANCE)";
                    finalClass = "status"; // Green
                } else if (tds <= 300) {
                    finalQuality = "GOOD / ACCEPTABLE (PLEASANT TO NORMAL TASTE)";
                    finalClass = "status"; // Green
                } else if (tds <= 500) {
                    finalQuality = "FAIR (NOTICEABLY HIGHER MINERAL TASTE)";
                    finalClass = "status warning"; // Yellow
                } else {
                    finalQuality = "POOR / UNACCEPTABLE (HARD, MINERAL-HEAVY)";
                    finalClass = "status dirty"; // Red
                }
            }

            // Adjust font size for long text
            finalStatusEl.style.fontSize = finalQuality.length > 25 ? "1.1rem" : "1.5rem";

            finalStatusEl.innerText = finalQuality;
            finalStatusEl.className = finalClass;
        }
    });
}
