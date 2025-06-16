const fetch = require('node-fetch');
const config = require('../config.json');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.File({ filename: 'error.log', level: 'error' })
  ]
});

async function fetchWeather(city) {
  try {
    const apiKey = config.weatherApiKey;
    if (!apiKey) {
      logger.error('Clé API OpenWeatherMap manquante dans config.json');
      return { error: 'Clé API invalide' }; // Correspond à t(lang, 'weather_invalid_key') dans commands.js
    }

    const response = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=fr`
    );

    if (!response.ok) {
      if (response.status === 404) {
        logger.warn(`Ville non trouvée : ${city}`);
        return { error: 'Ville non trouvée' };
      } else if (response.status === 401) {
        logger.error('Clé API OpenWeatherMap invalide');
        return { error: 'Clé API invalide' };
      }
      throw new Error(`Erreur HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.cod !== 200) {
      logger.error(`Erreur API OpenWeatherMap : ${data.message || 'Inconnue'}`);
      return { error: data.message || 'Erreur API inconnue' };
    }

    // Vérifier que les données météo sont disponibles
    if (!data.weather || !data.weather[0]) {
      logger.error(`Réponse API invalide pour ${city} : données météo manquantes`);
      return { error: 'Données météo indisponibles' };
    }

    logger.info(`Météo récupérée pour ${city}`);
    return {
      name: data.name,
      temp: Math.round(data.main.temp),
      feels_like: Math.round(data.main.feels_like),
      description: data.weather[0].description,
      humidity: data.main.humidity,
      wind_speed: data.wind.speed,
      icon: data.weather[0].icon
    };
  } catch (error) {
    // Inclure plus de détails dans les logs
    logger.error(`Erreur fetchWeather pour ${city} : ${error.message}${error.stack ? `\n${error.stack}` : ''}`);
    return { error: `Erreur lors de la récupération de la météo : ${error.message}` };
  }
}

module.exports = { fetchWeather };