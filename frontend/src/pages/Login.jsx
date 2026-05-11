import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    // Mock Login Logic
    // In a real app, you would verify with Firebase Auth
    if ((email === 'admin@jalboard.gov.in' || email === 'admin@gov.in') && password === 'admin123') {
      const userData = { email, role: 'admin', name: 'Jal Board Admin' };
      localStorage.setItem('user', JSON.stringify(userData));
      localStorage.setItem('token', 'mock-token-admin');
      navigate('/dashboard');
    } else if ((email === 'ramesh@gmail.com' || email === 'ramesh@gov.in') && password === 'ramesh123') {
      const userData = { email, role: 'consumer', name: 'Ramesh Kumar', nodeId: 'consumer_node' };
      localStorage.setItem('user', JSON.stringify(userData));
      localStorage.setItem('token', 'mock-token-ramesh');
      navigate('/consumer/consumer_node');
    } else if ((email === 'priya@gmail.com' || email === 'priya@gov.in') && password === 'priya123') {
      const userData = { email, role: 'consumer', name: 'Priya Patel', nodeId: 'consumer_node_8266' };
      localStorage.setItem('user', JSON.stringify(userData));
      localStorage.setItem('token', 'mock-token-priya');
      navigate('/consumer/consumer_node_8266');
    } else {
      setError('Invalid credentials. Please try again.');
    }
    setIsLoading(false);
  };

  return (
    <div className="auth-page-body">
      <div className="auth-container">
        <div className="auth-card">
          <h1>💧 Smart Water Grid</h1>
          <p>Access the real-time monitoring and control portal</p>
          
          <form onSubmit={handleLogin}>
            <div className="input-group">
              <label>Email Address</label>
              <input 
                type="email" 
                placeholder="e.g. admin@gov.in" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required 
              />
            </div>
            
            <div className="input-group">
              <label>Password</label>
              <input 
                type="password" 
                placeholder="••••••••" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required 
              />
            </div>
            
            <button type="submit" className="submit-btn" disabled={isLoading}>
              {isLoading ? 'Authenticating...' : 'Sign In to Portal'}
            </button>
            
            {error && <div className="error-msg">{error}</div>}
          </form>

          <div style={{ marginTop: '2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              <div style={{ marginBottom: '1rem', padding: '0.5rem', background: 'rgba(0,0,0,0.05)', borderRadius: '4px', textAlign: 'left' }}>
                <strong>Demo Credentials:</strong><br />
                Admin: <code>admin@gov.in</code> / <code>admin123</code><br />
                Node 1: <code>ramesh@gov.in</code> / <code>ramesh123</code><br />
                Node 2: <code>priya@gov.in</code> / <code>priya123</code>
              </div>
              Official Jal Board Infrastructure Portal
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
