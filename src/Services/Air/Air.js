import moment from 'moment';
import _ from 'lodash';

import { parsers } from '../../utils';
import airService from './AirService';
import createTerminalService from '../Terminal/Terminal';
import { AirRuntimeError } from './AirErrors';

module.exports = (settings) => {
  const service = airService(settings);
  return {
    shop(options) {
      return service.searchLowFares(options);
    },

    toQueue(options) {
      return service.gdsQueue(options);
    },

    book(options) {
      return service.airPricePricingSolutionXML(options).then((data) => {
        const bookingParams = Object.assign({}, {
          passengers: options.passengers,
          rule: options.rule,
          ticketDate: moment().add(3, 'hours').format(),
          ActionStatusType: 'TAU',
        }, data);
        return service.createReservation(bookingParams).catch((err) => {
          if (err instanceof AirRuntimeError.SegmentBookingFailed
              || err instanceof AirRuntimeError.NoValidFare) {
            const code = err.data['universal:UniversalRecord'].LocatorCode;
            return service.cancelUR({
              LocatorCode: code,
            }).then(() => Promise.reject(err));
          }
          return Promise.reject(err);
        });
      });
    },

    importPNR(options) {
      return service.importPNR(options);
    },

    ticket(options) {
      return service.importPNR(options).then((data) => {
        const ticketParams = Object.assign({}, options, {
          ReservationLocator: data[0].uapi_reservation_locator,
        });
        return service.ticket(ticketParams)
          .then(result => result, (err) => {
            if (err instanceof AirRuntimeError.TicketingFoidRequired) {
              return service.importPNR(options)
                .then(booking => service.foid(booking[0]))
                .then(() => service.ticket(ticketParams));
            }
            return Promise.reject(err);
          });
      });
    },

    flightInfo(options) {
      const parameters = {
        flightInfoCriteria: _.isArray(options) ? options : [options],
      };
      return service.flightInfo(parameters);
    },

    getTicket(options) {
      return service.getTicket(options)
        .catch((err) => {
          if (!(err instanceof AirRuntimeError.TicketInfoIncomplete)) {
            return Promise.reject(err);
          }
          return this.getPNRByTicketNumber({
            ticketNumber: options.ticketNumber,
          })
            .then(pnr => this.importPNR({ pnr }))
            .then(() => service.getTicket(options));
        });
    },

    getPNRByTicketNumber(options) {
      const terminal = createTerminalService(settings);
      const memo = {};
      return terminal.executeCommand(`*TE/${options.ticketNumber}`)
        .then(
          (response) => {
            memo.response = response;
          }
        )
        .then(terminal.closeSession)
        .then(
          () => {
            try {
              return memo.response.match(/RLOC [^\s]{2} ([^\s]{6})/)[1];
            } catch (err) {
              throw new AirRuntimeError.PnrParseError(memo.response);
            }
          }
        )
        .catch(
          err => Promise.reject(new AirRuntimeError.GetPnrError(options, err))
        );
    },

    getTickets(options) {
      return service.importPNR(options)
        .then(
           pnrData => Promise.all(
             pnrData[0].tickets.map(
               ticket => service.getTicket({ ticketNumber: ticket.number })
             )
           )
        )
        .catch(
          err => Promise.reject(new AirRuntimeError.UnableToRetrieveTickets(options, err))
        );
    },

    searchBookingsByPassengerName(options) {
      const terminal = createTerminalService(settings);
      return terminal.executeCommand(`*-${options.searchPhrase}`)
        .then((firstScreen) => {
          const list = parsers.searchPassengersList(firstScreen);
          if (list) {
            return Promise
              .all(list.map((line) => {
                const localTerminal = createTerminalService(settings);
                return localTerminal
                  .executeCommand(`*-${options.searchPhrase}`)
                  .then((firstScreenAgain) => {
                    if (firstScreenAgain !== firstScreen) {
                      return Promise.reject(
                        new AirRuntimeError.RequestInconsistency({
                          firstScreen,
                          firstScreenAgain,
                        })
                      );
                    }

                    return localTerminal.executeCommand(`*${line.id}`);
                  })
                  .then(parsers.bookingPnr)
                  .then(pnr => localTerminal.closeSession()
                    .then(() => ({ ...line, pnr }))
                  );
              }))
              .then(data => ({ type: 'list', data }));
          }

          const pnr = parsers.bookingPnr(firstScreen);
          if (pnr) {
            return {
              type: 'pnr',
              data: pnr,
            };
          }

          return Promise.reject(
            new AirRuntimeError.MissingPaxListAndBooking(firstScreen)
          );
        })
        .then(results =>
          terminal.closeSession()
            .then(() => results)
            .catch(() => results)
        );
    },
  };
};