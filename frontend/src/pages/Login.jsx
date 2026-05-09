import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    setTimeout(() => {
      if (email === 'admin@gov.in' && password === 'admin123') {
        localStorage.setItem('token', 'hardcoded-admin-token');
        localStorage.setItem('user', JSON.stringify({ email: 'admin@gov.in', role: 'admin' }));
        navigate('/dashboard');
      } else if (email === 'ramesh@gov.in' && password === 'ramesh123') {
        localStorage.setItem('token', 'hardcoded-consumer-token');
        localStorage.setItem('user', JSON.stringify({ email: 'ramesh@gov.in', role: 'consumer', nodeId: 'consumer_node', name: 'Ramesh Kumar' }));
        navigate('/consumer/consumer_node');
      } else if (email === 'priya@gov.in' && password === 'priya123') {
        localStorage.setItem('token', 'hardcoded-consumer-token');
        localStorage.setItem('user', JSON.stringify({ email: 'priya@gov.in', role: 'consumer', nodeId: 'consumer_node_8266', name: 'Priya Patel' }));
        navigate('/consumer/consumer_node_8266');
      } else {
        setError('Invalid credentials');
      }
      setLoading(false);
    }, 500);
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>Gov Dashboard</h1>
        <p>Please log in to access the system.</p>
        <form onSubmit={handleLogin}>
          <div className="input-group">
            <label>Admin Email</label>
            <input 
              type="email" 
              required 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@gov.in" 
            />
          </div>
          <div className="input-group">
            <label>Password</label>
            <input 
              type="password" 
              required 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••" 
            />
          </div>
          <button type="submit" disabled={loading}>
            {loading ? 'Authenticating...' : 'Secure Login'}
          </button>
        </form>
        {error && <div className="error-msg">{error}</div>}
      </div>
    </div>
  );
};

export default Login;
