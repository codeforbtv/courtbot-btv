import fs from 'fs';
import moment from 'moment-timezone';
import path from 'path';
import { Twilio } from "twilio";
import _ from 'lodash';
import { initialize, NotificationDao, ReminderDao } from '../dao/mongoose';
import { getInstanceMethods } from '../types/i-instance-methods';
import logger from '../utils/logger';

const client = new Twilio(process.env.TWILIO_ACCOUNT_SID || '', process.env.TWILIO_AUTH_TOKEN || '');

const sendReminders = async () => {
  try {
    // connect to database
    logger.debug('connecting to database');
    await initialize();
    logger.debug('connected');

    // get a list of instances
    const instanceDirectory = path.join(process.cwd(), './instances/');
    const items = fs.readdirSync(instanceDirectory);

    // go thru each item found in the directory
    for (let instanceIndex = 0; instanceIndex < items.length; instanceIndex++) {
      const instance = items[instanceIndex];
      try {
        // if the item is a directory then lets assume it's a valid instance
        if (fs.lstatSync(path.join(instanceDirectory, instance)).isDirectory()) {
          // get the case instance
          const instanceMethods = await getInstanceMethods(instance);

          // get the day after tomorrows start date & time to use as time bound
          const startDate = moment().toDate();
          const endDate = moment.tz(instanceMethods.getTimezone()).startOf('day').add(2, 'days').toDate();
          logger.info(`Searching for dates between ${startDate} - ${endDate}`, {
            metadata: {
              service: `send-reminders.ts`,
              instance,
            }
          });

          // find all cases within the time bounds
          const cases = await instanceMethods.findAll({
            startDate,
            endDate,
          });

          // add the test case for any reminders
          cases.push(await instanceMethods.getTestCase(1));

          // lets get a list of uids to query off
          const uids = cases.map(o => o.uid);
          logger.info(`Cases Found: ${uids}`, {
            metadata: {
              service: `send-reminders.ts`,
              instance,
            }
          });

          // find all reminders that match the dockets
          const reminders = await ReminderDao.find({
            active: true,
            uid: {
              $in: uids,
            },
          }).exec();

          // go thru each reminder to check to see if it matches a case
          // then send a text if it does
          for (let i = 0; i < reminders.length; i++) {
            const reminder = reminders[i];
            try {
              const c = _.find(cases, (o) => o.uid === reminder.uid);
              if (c) {
                // send the sms
                const options = {
                  to: reminder.phone,
                  from: process.env.TWILIO_PHONE_NUMBER,
                  body: `Just a reminder that you have an appointment coming up on ${moment(c.date).tz(instanceMethods.getTimezone()).format('l LT')} @ ${c.address}. Case is ${c.number}`,
                };
                logger.info(JSON.stringify(options), {
                  metadata: {
                    service: `send-reminders.ts`,
                    instance,
                    reminder: reminder.toJSON(),
                    case: c,
                  }
                });
                await client.messages.create(options);

                // set the reminder active to false
                await reminder.updateOne({ active: false });

                // add a notification entry
                await NotificationDao.create({
                  uid: reminder.uid,
                  number: reminder.number,
                  phone: reminder.phone,
                  event_date: c.date,
                });
              }
            }
            catch (ex) {
              logger.error(ex, {
                metadata: {
                  service: `send-reminders.ts`,
                  instance,
                  reminder: reminder.toJSON(),
                }
              });
            }
          }
        }
      }
      catch (ex) {
        logger.error(ex, {
          metadata: {
            service: `send-reminders.ts`,
            instance,
          }
        });
      }
    }
  } catch (ex) {
    logger.error(ex, {
      metadata: {
        service: `send-reminders.ts`,
      }
    });
  }
}

if (process !== undefined && process.env !== undefined && process.env.NODE_ENV === 'test') {
  module.exports = sendReminders;
} else {
  (async () => {
    sendReminders
    process.exit();
  })();
}