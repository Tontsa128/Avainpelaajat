import {createApp,loadConfig} from './app.js';
const config=loadConfig();const {server}=createApp(config);
server.listen(config.port,'127.0.0.1',()=>console.log(`Avainpelaaja OS palvelin kuuntelee http://127.0.0.1:${config.port}`));
