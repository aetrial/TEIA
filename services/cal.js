import axios from 'axios';
import pkg from 'pg';
import { DateTime } from 'luxon';
const { Client } = pkg;

const transformBusyDates = (busyArray, timeZone) => {
  return busyArray.map(({ start, end }) => {
    const startInBogota = DateTime.fromISO(start, { zone: 'utc' }).setZone(timeZone);
    const endInBogota = DateTime.fromISO(end, { zone: 'utc' }).setZone(timeZone);

    return {
      start: startInBogota.toISO(),
      end: endInBogota.toISO(),
    };
  });
};

export const checkAvailability = async ({ twilioId, dateFrom, dateTo }) => {
    try {

        console.log("twilioId:", twilioId);
        console.log("dateFrom:", dateFrom);
        console.log("dateTo:", dateTo);

        // Convert dateFrom and dateTo to UTC
        const dateFromUTC = new Date(dateFrom);
        dateFromUTC.setDate(dateFromUTC.getDate() + 348);
        const dateFromUpdated = dateFromUTC.toISOString();

        const dateToUTC = new Date(dateTo);
        dateToUTC.setDate(dateToUTC.getDate() + 348);
        const dateToUpdated = dateToUTC.toISOString();

        const {
                DB_HOST,
                DB_USER,
                DB_PASSWORD,
                DB_NAME
        } = process.env;

        if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
                console.error("Missing required environment variables");
                throw new Error("Missing required environment variables");
        }

        const client = new Client({
            host: DB_HOST,
            user: DB_USER,
            password: DB_PASSWORD,
            database: DB_NAME
        });
        await client.connect();

        const query = `
            SELECT * FROM cal_info ci
            JOIN teia_user tu ON tu.cal_info_id = ci.id
            JOIN twilio_info ti ON tu.twilio_info_id = ti.id
            WHERE ti.id = $1
            `;
       const res = await client.query(query, [twilioId]);

       if (res.rows.length === 0) {
             throw new Error("OpenAI information not found for the given Twilio ID");
       }

       const calInfo = res.rows[0];
       console.log("cal Info:", calInfo);

       const { user_id: userId, api_key: calApiKey, event_id: eventTypeId } = calInfo;

        const response = await axios.get('https://api.cal.com/v1/availability', {
            params: {
                userId,
                dateFrom: dateFromUTC,
                dateTo: dateToUTC,
                eventTypeId,
                apiKey: calApiKey
            }
        });

        const transformedBusy = transformBusyDates(response.data.busy, response.data.timeZone);

        response.data.busy = transformedBusy;

        return response.data;
    } catch (error) {
        console.error('Error checking availability:', error.response?.data || error.message);
        throw error;
    }
};

export const createBooking = async ({ twilioId, dateFrom, dateTo, responses }) => {
    try {

        // Convert dateFrom and dateTo to UTC
        const dateFromUTC = new Date(dateFrom).toISOString();
        const dateToUTC = new Date(dateTo).toISOString();

        const {
                DB_HOST,
                DB_USER,
                DB_PASSWORD,
                DB_NAME
        } = process.env;

        if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
                console.error("Missing required environment variables");
                throw new Error("Missing required environment variables");
        }

        const client = new Client({
            host: DB_HOST,
            user: DB_USER,
            password: DB_PASSWORD,
            database: DB_NAME
        });
        await client.connect();

        const query = `
            SELECT * FROM cal_info ci
            JOIN teia_user tu ON tu.cal_info_id = ci.id
            JOIN twilio_info ti ON tu.twilio_info_id = ti.id
            WHERE ti.id = $1
            `;
       const res = await client.query(query, [twilioId]);

       if (res.rows.length === 0) {
             throw new Error("OpenAI information not found for the given Twilio ID");
       }

       const calInfo = res.rows[0];
       console.log("cal Info:", calInfo);

       const { user_id: userId, api_key: calApiKey, event_id: eventTypeId } = openAiInfo;

        const response = await axios.post(`https://api.cal.com/v1/bookings?apiKey=${calApiKey}`, {
            responses,
            dateFromUTC,
            dateToUTC,
            eventTypeId,
            timeZone: "America/Bogota",
            language: "en",
            location: "",
            metadata: {},
            hasHashedBookingLink: false,
            hashedLink: null
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        console.error('Error creating booking:', error.response?.data || error.message);
        throw error;
    }
};