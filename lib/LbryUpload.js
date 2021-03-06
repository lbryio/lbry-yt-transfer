'use strict';
const logger = require('winston');
const request = require("request");
const sqlite3 = require('sqlite3');
var s3 = require('s3');
const fs = require('fs');
const db = new sqlite3.Database('db.sqlite');
var sleep = require('sleep');
const lbry = require('lbry-nodejs');

let _channelID;
let _customTag;
let _videosLocation;
let _channelName;
let _limit;

class LbryUpload {
  constructor(channelID, customTag, limit, videosLocation) {
    _channelID = channelID;
    _customTag = customTag;
    _videosLocation = videosLocation;
    _limit = limit;
    db.run("CREATE TABLE IF NOT EXISTS syncd_videos (videoid TEXT UNIQUE, claimname TEXT, claim_id TEXT, lbrychannel TEXT)");
  }
}

/**
 * Setter for the LBRY channel
 */
LbryUpload.prototype.setChannel = function (channel) {
  _channelName = channel;
  return checkChannelOwnership();
};

LbryUpload.prototype.performSyncronization = function () {
  return new Promise(function (fulfill, reject) {
    let processVideo = function (data) {
      data.forEach(row => {
        setupPayload(row)
          .then(publish)
          .then(savePublish)
          .catch(reject);
      });
    };

    lbry.status().then(daemonStatus => {
      if (daemonStatus.result.is_running === true)
        getAllUnprocessedVideos()
          .then(processVideo)
          .then(fulfill)
          .catch(reject);
    });
  });
};

/** 
 * Call this function to verify if a given channel name is owned
*/
function checkChannelOwnership() {
  return new Promise(function (fulfill, reject) {
    var options = {
      method: 'POST',
      url: 'http://localhost:5279/lbryapi',
      body: '{"method":"channel_list_mine" }'
    };

    request(options, function (error, response, body) {
      if (error) {
        return reject(error);
      }
      let resultSet = JSON.parse(body)['result'];
      for (let item of resultSet) {
        if (item.name === _channelName)
          return fulfill({ owned: true });
      }
      return reject({ channel_owned: false });
    });
  });
}

function getAllUnprocessedVideos() {
  //maximum amount of videos sync'd to LBRY in one run
  //console.log(_channelID);
  return new Promise(function (fulfill, reject) {
    //sync'd videos are not sync'd anymore, so every time the script is called it will upload $limit new videos
    const query =
      "SELECT videoid,channelid,fulltitle,description, thumbnail, data " +
      "FROM videos WHERE downloaded = 1 " +
      "AND videos.videoid NOT IN (select videoid FROM syncd_videos) " +
      "AND videos.channelid = '" + _channelID + "'" +
      ((_limit > 0) ? (" LIMIT " + _limit + ";") : ';');
    //console.log(query);

    db.all(query,
      function (err, rows) {
        if (err) {
          reject(err);
        }
        else {
          fulfill(rows);
        }
      });
  });
}


function setupPayload(row) {
  const filename = row.videoid + ".mp4";
  let name = _customTag + "-" + row.videoid.replace(/[^A-Za-z0-9\-]/g, '-');
  let filePath = _videosLocation + row.channelid + '/' + filename;
  return new Promise(function (fulfill, reject) {
    return lbry.wallet_list()
      .then(result => {
        if (result.hasOwnProperty('result') && Array.isArray(result.result)) {
          claimAddress = result.result[0];
          //check if the address starts with b (all LBRY addresses do)
          if (claimAddress.indexOf('b') === 0) {
            let payload = {
              params: {
                //claim names only allow chars and numbers and dashes
                name: name,
                file_path: filePath,
                claim_address: claimAddress,
                bid: 0.01,
                author: JSON.parse(row.data).channelTitle,
                description: row.description,
                language: "en",
                license: "Copyrighted (Contact Author)",
                nsfw: false,
                //this could become row.thumbnail however thumbs that failed uploading would cause claims to have invalid URLS until updated
                thumbnail: "http://berk.ninja/thumbnails/" + row.videoid,
                title: row.fulltitle/*,
                fee: {
                  currency: 'LBC',
                  address: 'bDYwcbtd42PGDLLznv4ak55Lidx3KLhzuA',
                  amount: 1.0
                }*/
              }
            };

            //if the user has specified a channel, then the claim will be attached to such channel
            if (_channelName !== null) {
              payload.params.channel_name = _channelName;
            }
            logger.log("[YT-LBRY] publish payload: %s", payload);
            return fulfill({ payload: payload, filename: filename, videodata: row });
          }
        }
        return reject({ error: 'error in selecting the destination address', details: result });
      }).catch(reject);
  });
};

/**
 * publish to lbry
 * @param {Object} payloadBundle
 */
function publish(payloadBundle, failures) {
  if (typeof failures === 'undefined') {
    failures = 1;
  }
  logger.info("Publishing %s - %s", payloadBundle.payload.params.name, payloadBundle.payload.params.title);
  return new Promise(function (fulfill, reject) {
    return lbry.publish(payloadBundle.payload.params.name, 1.0, payloadBundle.payload.params)
      .catch(reject)
      .then(body => {
        if (body.hasOwnProperty('error')) {
          if (failures < 1) {
            logger.error("Failed to claim %s (%d/3) due to: \n%s", payloadBundle.payload.params.name, failures, JSON.stringify(body));
            return publish(payloadBundle, ++failures).then(fulfill).catch(reject);
          }
          else {
            logger.error("Failed to claim %s due to: \n%s", payloadBundle.payload.params.name, JSON.stringify(body));
            return reject(body);
          }
        }
        else {
          logger.info("[YT-LBRY] Success in publishing %s", payloadBundle.payload.params.name);
          //logger.info("body: %s", JSON.stringify(body));
          return fulfill({ claimname: payloadBundle.payload.params.name, videodata: payloadBundle.videodata, daemonraw: body });
        }
      });
  });
}

function savePublish(publishResponse) {
  const filename = _videosLocation + _channelID + '/' + publishResponse.videodata.videoid + ".mp4"
  logger.info('Published ' + filename + " to " + publishResponse.claimname);
  db.serialize(function () {
    const stmt = db.prepare("INSERT OR IGNORE INTO syncd_videos VALUES (?,?,?,?);");
    stmt.run(publishResponse.videodata.videoid, publishResponse.claimname, publishResponse.daemonraw.result.claim_id, ((_channelName !== null) ? _channelName : ''));
    stmt.finalize();
  });
  fs.unlink(filename, err => {
    logger.info(err ? ("unlink failed: " + err) : ("file deleted: " + filename))
  });
}

module.exports = LbryUpload;