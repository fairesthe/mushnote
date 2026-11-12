# mushnote

minimal black oled note taking app with real time sync and ai agent

## setup --------------------

1. install dependencies
```bash
npm --prefix backend install
```

2. configuration
copy `resources/config.example.yaml` to `config.yaml` if it does not exist (the app also auto generates it on first boot)
add your gemini api key to `config.yaml`

## running --------------------

start the server
```bash
npm --prefix backend start
```

or run in development watch mode
```bash
npm --prefix backend run dev
```

open `http://localhost:3000` in your browser

