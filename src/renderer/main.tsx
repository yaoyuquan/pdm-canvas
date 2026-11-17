import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.compactAlgorithm,
        token: { colorPrimary: '#2f6fed', borderRadius: 4, fontSize: 13 },
      }}
    >
      <AntApp className="app-root">
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
