// weather service --------------------
let weathercache = null
let lastfetchtime = 0
const cachettlms = 15 * 60 * 1000 // 15 min cache

// format weather summary string --------------------
function formatweather(data, units = 'imperial') {
  if (!data || !data.current_condition || !data.current_condition[0]) {
    return null
  }

  const current = data.current_condition[0]
  const today = data.weather && data.weather[0] ? data.weather[0] : null
  const desc = current.weatherDesc && current.weatherDesc[0] ? current.weatherDesc[0].value.trim() : 'Unknown'
  const ismetric = units === 'metric' || units === 'celsius' || units === 'c'

  const temp = ismetric ? `${current.temp_C}°C` : `${current.temp_F}°F`
  const feels = ismetric ? `${current.FeelsLikeC}°C` : `${current.FeelsLikeF}°F`
  const humidity = current.humidity ? `${current.humidity}%` : null

  let highlow = ''
  if (today) {
    const high = ismetric ? `${today.maxtempC}°C` : `${today.maxtempF}°F`
    const low = ismetric ? `${today.mintempC}°C` : `${today.mintempF}°F`
    highlow = ` | High: ${high} Low: ${low}`
  }

  const humiditystr = humidity ? ` | Humidity: ${humidity}` : ''
  return `${desc}, ${temp} (feels like ${feels})${highlow}${humiditystr}`
}

// fetch weather data with caching --------------------
export async function getweather(locationconfig) {
  if (!locationconfig) {
    return null
  }

  // support location as a string or object --------------------
  let query = ''
  let units = 'imperial'

  if (typeof locationconfig === 'string') {
    query = locationconfig.trim()
  } else if (typeof locationconfig === 'object') {
    query = locationconfig.city || locationconfig.query || locationconfig.name || ''
    if (locationconfig.units) {
      units = locationconfig.units
    }
  }

  if (!query) {
    return null
  }

  const now = Date.now()
  if (weathercache && weathercache.query === query && weathercache.units === units && now - lastfetchtime < cachettlms) {
    return weathercache.summary
  }

  try {
    const encoded = encodeURIComponent(query)
    const res = await fetch(`https://wttr.in/${encoded}?format=j1`, {
      headers: { 'User-Agent': 'mushnote/1.0' },
      signal: AbortSignal.timeout(5000)
    })

    if (!res.ok) {
      return weathercache ? weathercache.summary : null
    }

    const data = await res.json()
    const summary = formatweather(data, units)

    if (summary) {
      weathercache = { query, units, summary }
      lastfetchtime = now
      return summary
    }
  } catch (err) {
    // network or timeout error fallback to previous cache --------------------
    if (weathercache && weathercache.query === query) {
      return weathercache.summary
    }
  }

  return null
}

