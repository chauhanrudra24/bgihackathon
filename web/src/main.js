import { auth, db } from './firebase';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { ref, get } from 'firebase/database';

const loginForm = document.getElementById('loginForm');
const errorMsg = document.getElementById('errorMsg');
const loginBtn = document.getElementById('loginBtn');

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    
    errorMsg.innerText = '';
    loginBtn.innerText = 'Authenticating...';
    loginBtn.disabled = true;

    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;
      
      // Check role in Realtime Database
      const roleRef = ref(db, `users/${user.uid}/role`);
      const snapshot = await get(roleRef);
      
      if (snapshot.exists() && snapshot.val() === 'admin') {
        window.location.href = '/dashboard.html';
      } else {
        errorMsg.innerText = 'Access Denied: You do not have admin privileges.';
        auth.signOut();
      }
    } catch (error) {
      errorMsg.innerText = 'Login Failed. Check credentials.';
      console.error(error);
    } finally {
      loginBtn.innerText = 'Secure Login';
      loginBtn.disabled = false;
    }
  });
}
