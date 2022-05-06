const app = require("express")()
require('dotenv').config()
const bodyParser = require('body-parser');
const cryptoJs = require("crypto-js");
const fs = require('fs');
const process = require('process');
const util = require('util')
const exec = util.promisify(require('child_process').exec);
app.use(bodyParser.json())

app.post('/', async (req, res) => {
    //res.status(202).json({ status: 'processando' })
    app.locals.res = res
    app.locals.body = req.body
    let bd = JSON.stringify(req.body)
    let hmacCoded = 'sha256=' + hmac(process.env.HASH_PASS, bd)
    let shaHead = req.headers["x-hub-signature-256"]

    if (shaHead == hmacCoded) {
        findRepo(req.body)
    } else {
        app.locals.res.status(403).json({ status: 'error - SHA256', repoStatus: 'not updated', serviceStatus: 'not running', error: "sha256 don't match" })
    }
})

function hmac(key, data) {
    let bytes = cryptoJs.HmacSHA256(data, key)
    return bytes.toString()
}

function findRepo(body) {

    if (!body.repository) {
        app.locals.res.status(403).json({ status: 'error - no repository', repoStatus: 'not updated', serviceStatus: 'not running', error: "no repository in body" })
        return
    }

    let repoName = body.repository.name
    let exists = false

    fs.readdir('/home/repos', function (err, files) {
        //handling error
        if (err) {
            return console.log('Unable to scan directory: ' + err);
        }

        for (let c = 0; c <= files.length; c++) {
            if (files[c] == repoName) {
                exists = true
                break
            }
        }

        exists ? pull(body.repository) : clone(body.repository)
    })
}

async function pull(repo) {
    try {
        // cd into the repo dir
        process.chdir(`/home/repos/${repo.name}`);
        // exec the pull to update the repo
        const { stdout, stderr } = await exec(`git pull`)

        if (stdout) {
            console.log("[stdout] => git pull: ", stdout)
        } else if (stderr) {
            console.log("[stderr] => git pull: ", stderr)
        }

    } catch (err) {
        app.locals.res.status(500).json({ status: 'error -> pull', repoStatus: 'not updated', serviceStatus: 'not running', error: err })
        console.error(err);
        return
    }
    goLive(repo)
}

async function clone(repo) {
    try {
        // cd into de the repos dir
        process.chdir(`/home/repos`);
        const { stdout, stderr } = await exec(`git clone ${repo.ssh_url}`)

        if (stdout) {
            console.log("[stdout] => git clone: ", stdout)
        } else if (stderr) {
            console.log("[stderr] => git clone: ", stderr)
        }

    } catch (err) {
        app.locals.res.status(500).json({ status: 'error -> clone', repoStatus: 'not updated', serviceStatus: 'not running', error: err })
        console.error(err)
        return
    }
    goLive(repo)
}

async function goLive(repo) {
    // find if the repo has an init.sh file
    let files = fs.readdirSync(`/home/repos/${repo.name}`, function (err, files) {
        //handling error
        if (err) {
            return console.log('Unable to scan directory: ' + err);
        } else {
            return files
        }
    })

    for (let c = 0; c <= files.length; c++) {
        if (files[c] == 'init.sh') {
            let isIllegal = await testInit(repo.name)

            if (!isIllegal) {
                // checker de user, only admins can run the proj
                let admins = process.env.FULL_ACCESS.split(',')

                if (admins.indexOf(app.locals.body.head_commit.author.username) === -1) {
                    app.locals.res.status(403).json({ status: 'error -> not admin', repoStatus: 'updated', serviceStatus: 'not created/ not running' })
                } else {
                    createService(repo)
                }
            }
            break;
        }
    }
}

// func to validate o init.sh and validate the users that can run the service
async function testInit(repo) {

    let data = fs.readFileSync(`/home/repos/${repo}/init.sh`, (err, data) => {
        if (err) {
            app.locals.res.status(500).json({ status: 'error -> read sh', repoStatus: 'updated', serviceStatus: ' not created/ not running', error: err })
            console.error(err)
            return
        } else {
            data = data.toLocaleString()
            return data
        }
    })

    let regex = /(crontab|wget|mkfs|pwd|mkdir|vim|vi|rm|rmdir|mv|cp|apt|remove|shutdown|fdisk|mount|unmount|ssh|chmod|chown|chgrp|useradd|adduser|deluser|usermod|kill|kilall|modprobe|hdparm)/
    let test = regex.test(data)

    if (test) {
        app.locals.res.status(403).json({ status: 'error -> init.sh had invalid arguments', repoStatus: 'updated', serviceStatus: ' not created/ not running' })
        return true
    } else {
        return false
    }
}

function createService(repo) {
    let description;
    repo.description != null ? description = repo.description : description = 'no description provided'

    let data =
        `[Unit]
Description=${repo.name} - ${description}

[Service]
User=root
WorkingDirectory=/home/repos/${repo.name}/
ExecStart=/bin/bash /home/repos/${repo.name}/init.sh
Restart=always

[Install]
WantedBy=multi-user.target`

    // reads the repository to find if there is already an .service file, ifnot, create, else exec it
    /* 
        - note -
        if you make change to an existing .service file you will need to run 'systemctl daemon-reload'
    
    */

    fs.readdir(`/etc/systemd/system`, function (err, files) {
        if (err) {
            return console.log('Unable to scan directory: ' + err);
        }

        if (files.includes(repo.name.toLowerCase() + '.service')) {
            runer(repo, true)
        } else {
            process.chdir(`/etc/systemd/system/`)
            fs.writeFileSync(repo.name.toLowerCase() + '.service', data)
            runer(repo, false)
        }
    })
}

async function runer(repo, exists) {
    process.chdir(`/etc/systemd/system/`)

    // if it already exists we just need to reload de daemon and restart
    if (exists) {
        daemonReload()

        try {
            const { stdout, stderr } = await exec(`systemctl restart ${repo.name.toLowerCase()}`)

            if (stdout) {
                console.log("[stdout] => sysctl restart: ", stdout)
            } else if (stderr) {
                console.log("[stderr] => sysctl restart: ", stderr)
            }
            app.locals.res.status(200).json({ status: 'ok -> reloaded', repoStatus: 'updated', serviceStatus: 'running / enabled' })

        } catch (err) {
            app.locals.res.status(500).json({ status: 'error -> restart service', repoStatus: 'updated', serviceStatus: 'not running', error: err })
            console.error(err)
            return
        }
    } else {
        // runs chmod to change permissions
        try {
            const { stdout, stderr } = await exec(`chmod +x ${repo.name.toLowerCase()}.service`)
            if (stdout) {
                console.log("[stdout] => chmod: ", stdout)
            } else if (stderr) {
                console.log("[stderr] => chmod: ", stderr)
            }
        } catch (err) {
            app.locals.res.status(500).json({ status: 'error -> chmod', repoStatus: 'updated', serviceStatus: 'not running', error: err })
            console.error(err)
            return
        }

        // enables the service to run on startup
        try {
            const { stdout, stderr } = await exec(`systemctl enable ${repo.name.toLowerCase()}.service &`)

            if (stdout) {
                console.log("[stdout] => enable: ", stdout)
            } else if (stderr) {
                console.log("[stderr] => enable: ", stderr)
            }
        } catch (err) {
            app.locals.res.status(500).json({ status: 'error -> sysctl enable', repoStatus: 'updated', serviceStatus: 'running / enabled', error: err })
            console.error(err)
            return
        }

        daemonReload()

        // runs the file
        try {
            const { stdout, stderr } = await exec(`systemctl start ${repo.name.toLowerCase()}.service &`)

            if (stdout) {
                console.log("[stdout] => start script: ", stdout)
            } else if (stderr) {
                console.log("[stderr] => start script: ", stderr)
            }
            app.locals.res.status(200).json({ status: 'ok -> started', repoStatus: 'updated', serviceStatus: 'running / enabled' })
        } catch (err) {
            app.locals.res.status(500).json({ status: 'error -> run', repoStatus: 'updated', serviceStatus: 'not running', error: err })
            console.error(err)
            return
        }
    }

    async function daemonReload() {
        // atualizes the daemon
        if (!exists) {
            try {
                const { stdout, stderr } = await exec(`systemctl daemon-reload`)

                if (stdout) {
                    console.log("[stdout] => daemon-reload: ", stdout)
                } else if (stderr) {
                    console.log("[stderr] => daemon-reload: ", stderr)
                }
            } catch (err) {
                app.locals.res.status(500).json({ status: 'error -> daemon-reload', repoStatus: 'updated', serviceStatus: 'not running', error: err })
                console.error(err)
                return
            }
        }
    }
}

app.listen(process.env.PORT, () => {
    console.log(`[NODE.JS] => Server (githubCI) escutando na porta: ${process.env.PORT}`)
})