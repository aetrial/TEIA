import axios from 'axios';
import { DateTime } from 'luxon';
import pool from './db.js';

const transformBusyDates = (slots, timeZone) => {
  return Object.entries(slots).flatMap(([date, times]) => {
    return times.map(({ time }) => {
      const startInBogota = DateTime.fromISO(time, { zone: 'utc' }).setZone(timeZone);
      return {
        time: startInBogota.toISO(),
      };
    });
  });
};

export const checkAvailability = async ({ twilioId, dateFrom, dateTo }) => {
    let client;
    try {

        console.log("Entering checkAvailability function");

        console.log("twilioId:", twilioId);
        console.log("dateFrom:", dateFrom);
        console.log("dateTo:", dateTo);

        // Convert dateFrom and dateTo to UTC
        const dateFromUTC = new Date(dateFrom);
        dateFromUTC.setDate(dateFromUTC.getDate());

        const dateToUTC = new Date(dateTo);
        dateToUTC.setDate(dateToUTC.getDate());

        client = await pool.connect();

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

        const response = await axios.get('https://api.cal.com/v1/slots', {
            params: {
                startTime: dateFromUTC,
                endTime: dateToUTC,
                eventTypeId,
                apiKey: calApiKey
            }
        });

        const transformedBusy = transformBusyDates(response.data.slots, response.data.timeZone);

        response.data.slots = transformedBusy;

        return response.data;
    } catch (error) {
        console.error('Error checking availability:', error.response?.data || error.message);
        throw error;
    } finally {
        if (client) {
            client.release();
        }
    }
};

export const createBooking = async ({ twilioId, dateFrom, dateTo, responses }) => {
    let client;
    try {

        console.log("Entering createBooking function");

        console.log("twilioId:", twilioId);
        console.log("dateFrom:", dateFrom);
        console.log("dateTo:", dateTo);
        console.log("responses:", responses);

        client = await pool.connect();

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

        const eventTypeIdInt = parseInt(eventTypeId, 10); // Cast to integer with base 10

        const response = await axios.post(`https://api.cal.com/v1/bookings?apiKey=${calApiKey}`, {
            responses,
            start: dateFrom,
            end: dateTo,
            eventTypeId: eventTypeIdInt,
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
        if (error.response?.data?.message === 'no_available_users_found_error') {
            console.error('Error response:', error.response.data.message);
            return error.response.data.message;
        }
        console.error('Error creating booking:', error.response?.data || error.message);
        throw error;
    } finally {
        if (client) {
            client.release();
        }
    }
};