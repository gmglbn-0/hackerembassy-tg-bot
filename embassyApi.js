require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require('body-parser');
const printer3d = require("./services/printer3d");
const {getDoorcamImage, getWebcamImage } = require("./services/media");
const find = require("local-devices");
const { LUCI } = require("luci-rpc");
const fetch = require("node-fetch");
const logger = require("./services/logger");
const { unlock } = require("./services/mqtt");
const { decrypt } = require("./utils/security");

const config = require("config");
const embassyApiConfig = config.get("embassy-api");
const port = embassyApiConfig.port;
const routerip = embassyApiConfig.routerip;
const wifiip = embassyApiConfig.wifiip;

const app = express();
app.use(cors());
app.use(bodyParser.json()); 

const {NodeSSH} = require('node-ssh');

app.get("/doorcam", async (_, res) => {
  try {
    res.send(await getDoorcamImage());
  } catch (error) {
    logger.error(error);
    res.send({ message: "Device request failed", error });
  }
});

app.get("/webcam", async (_, res) => {
  try {
    res.send(await getWebcamImage());
  } catch (error) {
    logger.error(error);
    res.send({ message: "Device request failed", error });
  }
});

app.post("/unlock", async (req, res) => {
  try {
    let token = await decrypt(req.body.token);
    
    if (token === process.env["UNLOCKKEY"]) {
      unlock();
      logger.info("Door is opened");
      res.send("Success");
    } else res.sendStatus(401);
  } catch (error) {
    logger.error(error);
    res.send(error);
  }
});

app.get("/devicesscan", async (_, res) => {
  let devices = await find({ address: embassyApiConfig.networkRange });
  res.send(devices.map((d) => d.mac));
});

app.get("/doorbell", async (_, res) => {
  try {
    await fetch(`http://${embassyApiConfig.doorbell}/rpc/Switch.Set?id=0&on=true`);
    res.send({message: "success"});
  } catch (error) {
    res.send({message: "error"});
  }
});

app.get("/devices", async (_, res) => {
  try {
    const luci = new LUCI(`https://${routerip}`, "bot", process.env["LUCITOKEN"]);
    await luci.init();
    luci.autoUpdateToken(1000 * 60 * 30);

    let rpc = [
      {
        jsonrpc: "2.0",
        id: 93,
        method: "call",
        params: [luci.token, "iwinfo", "assoclist", { device: "phy0-ap0" }],
      },
      {
        jsonrpc: "2.0",
        id: 94,
        method: "call",
        params: [luci.token, "iwinfo", "assoclist", { device: "phy1-ap0" }],
      },
    ];

    let response = await fetch(`http://${routerip}/ubus/`, {
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rpc),
      method: "POST",
    });

    let adapters = await response.json();
    let macs = [];

    for (const wlanAdapter of adapters) {
      let devices = wlanAdapter.result[1]?.results;
      if (devices)
        macs = macs.concat(devices.map((dev) => dev.mac.toLowerCase()));
    }
    
    res.send(macs);
  } catch (error) {
    logger.error(error);
    res.send({ message: "Device request failed", error });
  }
});

app.get("/devicesFromKeenetic", async (_, res) => {
  try {
    const ssh = new NodeSSH()

    await ssh.connect({
      host: wifiip,
      username: process.env["WIFIUSER"],
      password: process.env["WIFIPASSWORD"]
    })

    let sshdata = await ssh.exec("show associations", [""]);
    let macs = [...sshdata.matchAll(/mac: ((?:[0-9A-Fa-f]{2}[:-]){5}(?:[0-9A-Fa-f]{2}))/gm)]. map(item=>item[1]);
    res.json(macs);
  } catch (error) {
    logger.error(error);
    res.send({ message: "Device request failed", error });
  }
});

app.get("/printer", async (_, res) => {
  try {
    let fileMetadata;
    let thumbnailBuffer;
    let cam;
    let statusResponse = await printer3d.getPrinterStatus();
    let status = statusResponse && statusResponse.result.status;

    if (status) {
      let fileMetadataResponse = await printer3d.getFileMetadata(status.print_stats && status.print_stats.filename);
      try {
        cam = await printer3d.getCam();
      }
      catch {
        cam = null;
      }

      if (fileMetadataResponse) {
        fileMetadata = fileMetadataResponse.result;
        let thumbnailPath = fileMetadata && fileMetadata.thumbnails && fileMetadata.thumbnails[fileMetadata.thumbnails.length - 1].relative_path;
        thumbnailBuffer = await printer3d.getThumbnail(thumbnailPath);
      }
    }

    res.send({ status, thumbnailBuffer, cam });
  } catch (error) {
    logger.error(error);
    res.send({ message: "Printer request error", error });
  }
});

app.listen(port);

logger.info(`Embassy Api is started on port ${port}`);
