/**
 * @author Tres Finocchiaro
 *
 * Copyright (C) 2017 Tres Finocchiaro, QZ Industries, LLC
 *
 * LGPL 2.1 This is free software.  This software and source code are released under
 * the "LGPL 2.1 License".  A copy of this license should be distributed with
 * this software. http://www.gnu.org/licenses/lgpl-2.1.html
 */

/**********************************************************************************************
 *                        Windows KeyGen Utility                                              *
 **********************************************************************************************
 *  Description:                                                                              *
 *    Utility to create a private key and install its respective public certificate to the    *
 *    system.  When run in "uninstall" mode, the public certificate is removed based on       *
 *    matched publisher/vendor information.                                                   *
 *                                                                                            *
 *  INSTALL:                                                                                  *
 *    1. Creates a self-signed Java Keystore for jetty wss://localhost                        *
 *    2. Exports public certificate from Java Keystore                                        *
 *    3. Imports into Windows trusted cert store                                              *
 *    4. Imports into Firefox web browser (if installed)                                      *
 *                                                                                            *
 *       Note:  If [ssl_cert] and [ssl_key] are specified, import to browser/OS is omitted.   *
 *                                                                                            *
 *  UNINSTALL                                                                                 *
 *    1. Deletes certificate from Windows trusted cert store                                  *
 *    2. Deletes certificate from Firefox web browser (if installed)                          *
 *                                                                                            *
 *  Depends:                                                                                  *
 *    keytool.exe (distributed with jre: http://java.com)                                     *
 *                                                                                            *
 *  Usage:                                                                                    *
 *    cscript //NoLogo windows-keygen.js                                                      *
 *      "C:\Program Files\QZ Tray" install [hostname] [portable_firefox] [ssl_cert] [ssl_key] *
 *                                                                                            *
 *    cscript //NoLogo windows-keygen.js                                                      *
 *      "C:\Program Files\QZ Tray" uninstall [hostname] [portable_firefox]                    *
 *                                                                                            *
 **********************************************************************************************/

var shell = new ActiveXObject("WScript.shell");
var fso = new ActiveXObject("Scripting.FileSystemObject");
var newLine = "\r\n";

// Uses passed-in parameter as install location.  Will fallback to registry if not provided.
var qzInstall = getArg(0, getRegValue("HKLM\\Software\\QZ Tray\\"));
var installMode = getArg(1, "install");
var cnOverride = getArg(2, null);
var firefoxPortable = getArg(3, null);
var trusted = { cert: getArg(4, null), key: getArg(5, null) };

var firefoxInstall;

/**
 * Prototypes and polyfills
 */
String.prototype.replaceAll = function(search, replacement) {
    var target = this;
    return target.replace(new RegExp(search, 'g'), replacement);
};

if (typeof console === 'undefined') {
    var console = {
        log: function(msg) { WScript.Echo(msg); },
        warn: function(msg) { WScript.Echo("WARN: " + msg); },
        error: function(object, status) {
            WScript.Echo("ERROR: " + (typeof object === 'object' ? object.message : object));
            WScript.Quit(status ? status : -1);
        }
    }
}

if (installMode == "install") {
    var password, javaEnv;
    if (trusted.cert && trusted.key) {
        createPKCS12();
        createJavaKeystore();
    } else if (createJavaKeystore()) {
        try { installWindowsCertificate(); }
        catch (err) { installWindowsXPCertificate(); }
        if (hasFirefoxConflict()) {
            alert("WARNING: QZ Tray installation would conflict with an existing Firefox AutoConfig rule.\n\n" +
                "Please notify your administrator of this warning.\n\n" +
                "The installer will continue, but QZ Tray will not function with Firefox until this conflict is resolved.",
                "Firefox AutoConfig Warning");
        } else {
            installFirefoxCertificate();
        }
    }
} else {
    try { deleteWindowsCertificate(); }
    catch (err) { deleteWindowsXPCertificate(); }
    deleteFirefoxCertificate();
}

WScript.Quit(0);

/**
 * Deletes a file
 */
function deleteFile(filePath) {
	if (fso.FileExists(filePath)) {
		try {
			fso.DeleteFile(filePath);
		} catch (err) {
			console.error("Unable to delete " + filePath);
		}
	}
}

function java() {
    if (!javaEnv) {
        var regKey = "HKLM\\Software\\JavaSoft\\Java Runtime Environment\\";
        var jreHome = getRegValue(regKey + getRegValue(regKey + "CurrentVersion") + "\\JavaHome");
        var keyTool = jreHome + "\\bin\\keytool.exe";
        javaEnv = {
            regKey: regKey,
            jreHome: jreHome,
            keyTool: keyTool
        };
    }
    return javaEnv;
}

/**
 * Generates a random string to be used as a password
 */
function pw() {
    if (!password) {
        password = "";
        var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        for( var i=0; i < parseInt("10"); i++ ) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    }
    return password;
}

/**
 * Reads a registry value, taking 32-bit/64-bit architecture into consideration
 */
function getRegValue(path) {
	// If 64-bit OS, try 32-bit registry first
	if (shell.ExpandEnvironmentStrings("ProgramFiles(x86)")) {
		path = path.replace("\\Software\\", "\\Software\\Wow6432Node\\");
	}

	var regValue = "";
	try {
		regValue = shell.RegRead(path);
	} catch (err) {
		try {
            // Fall back to 64-bit registry
            path = path.replace("\\Software\\Wow6432Node\\", "\\Software\\");
            regValue = shell.RegRead(path);
		} catch (err) {}
	}
	return regValue;
}

/**
 * Displays a message regarding whether or not a file exists
 */
function verifyExists(path, msg) {
    var success = fso.FileExists(path);
    console.log(" - " + (success ? "[success] " : "[failed] ") + msg);
    return success;
}

/**
 * Displays a message regarding whether or not a command succeeded
 */
function verifyExec(cmd, msg) {
    try {
        var success = shell.Run(cmd, 0, true) == 0;
        console.log(" - " + (success ? "[success] " : "[failed] ") + msg);
        return success;
    } catch(err) {
        console.log(' - [failed] Error executing "' + cmd + '"');
        return false;
    }
}

/**
 * Replaces "!install" with proper location, usually "C:\Program Files\", fixes forward slashes
 */
function fixPath(path) {
    var removeTrailing = qzInstall.replace(/\\$/, "").replace(/\/$/, "");
    return path.replace("!install", removeTrailing).replace(/\//g, "\\");
}

function replaceVars(cmd) {
    var c = cmd;

    // Handle CN=localhost override
    if (cnOverride) {
        c = c.replace("CN=localhost,", "CN=" + cnOverride + ",")
            .replace("san=dns:localhost,", "san=" + (isIp4(cnOverride) ? "ip:" : "dns:" ) + cnOverride + ",")
            .replace(",dns:localhost.qz.io", "");
    }

    return c.replaceAll("!install/auth/root-ca.jks", fixPath("!install/auth/root-ca.jks"))
            .replaceAll("!install/auth/root-ca.crt", fixPath("!install/auth/root-ca.crt"))
            .replaceAll("!install/auth/qz-tray.jks", fixPath("!install/auth/qz-tray.jks"))
            .replaceAll("!install/auth/qz-tray.crt", fixPath("!install/auth/qz-tray.crt"))
            .replaceAll("!install/auth/qz-tray.csr", fixPath("!install/auth/qz-tray.csr"))
            .replaceAll("!storepass", pw())
            .replaceAll("!keypass", pw())
            .replaceAll("!sslcert", trusted.cert)
            .replaceAll("!sslkey", trusted.key)
            .replaceAll("keytool", java().keyTool)
            .replaceAll("!install/auth/qz-tray.p12", fixPath("!install/auth/qz-tray.p12"));
 }

/*
 * Reads in a text file, expands the specified named variable replacements and writes it back out.
 */
function writeParsedConfig(inPath, outPath, replacements) {
    var inFile = fso.OpenTextFile(inPath, 1, true);     // 1 = ForReading
    var outFile = fso.OpenTextFile(outPath, 2, true);   // 2 = ForWriting

    while(!inFile.AtEndOfStream) {
        line = inFile.ReadLine()

        // Process all variable replacements
        for (var key in replacements) {
            if (!replacements.hasOwnProperty(key)) continue;
            // Escape leading "$" prior to building regex
            var varName = (key.indexOf("$") == 0 ? "\\" + key : key);
            var re = new RegExp(varName, 'g')
            line = line.replace(re, replacements[key]);
        }
        outFile.WriteLine(line);
    }
    inFile.close();
    outFile.close();
}

/*
 * Reads in a X509 certificate, stripping BEGIN, END and NEWLINE string
 */
function readPlainCert(certPath) {
    var certFile = fso.OpenTextFile(certPath, 1, true);
    var certData = "";
    while (!certFile.AtEndOfStream) { certData += strip(certFile.ReadLine()); }
    certFile.close();
    return certData;
}

/*
 * Strips non-base64 data (i.e RFC X509 --START, --END) from a string
 */
function strip(line) {
    var X509 = ["-----BEGIN CERTIFICATE-----", "-----END CERTIFICATE-----", "\r", "\n"];
    for (var i in X509) { line = line.replace(new RegExp(X509[i], 'g'), ''); }
    return line;
}

/*
 * Creates the Java Keystore
 */
function createJavaKeystore() {
    var success = false;

    if (!java().jreHome) {
        console.error("Can't find JavaHome.  Secure websockets will not work.", "2");
    }

    if (!qzInstall) {
        console.error("Can't find QZ Tray installation path. Secure websockets will not work.", "4");
    }

    deleteFile(fixPath("!install/auth/qz-tray.jks"));
    deleteFile(fixPath("!install/auth/qz-tray.crt"));

    console.log("Creating keystore for wss://" + (cnOverride || "localhost") + " (this could take a minute)...");

    if (trusted.cert) {
        success = verifyExec(replaceVars("\"keytool\" -importkeystore -deststorepass !storepass -destkeypass !keypass -destkeystore \"!install/auth/qz-tray.jks\" -srckeystore \"!install/auth/qz-tray.p12\" -srcstoretype PKCS12 -srcstorepass !storepass -alias qz-tray"), "Converting trusted keypair to Java format");
    } else {
        deleteFile(fixPath("!install/auth/root-ca.jks"));
        deleteFile(fixPath("!install/auth/root-ca.crt"));
        deleteFile(fixPath("!install/auth/qz-tray.jks"));
        deleteFile(fixPath("!install/auth/qz-tray.csr"));

        success = verifyExec(replaceVars("\"keytool\" -genkeypair -noprompt -alias root-ca -keyalg RSA -keysize 2048 -dname \"CN=localhost, EMAILADDRESS=support@qz.io, OU=QZ Industries\\, LLC, O=QZ Industries\\, LLC, L=Canastota, S=NY, C=US\" -validity 7305 -keystore \"!install/auth/root-ca.jks\" -keypass !keypass -storepass !storepass -ext ku:critical=cRLSign,keyCertSign -ext bc:critical=ca:true,pathlen:1"), "Creating a CA keypair: !install/auth/root-ca.jks") &&
            verifyExec(replaceVars("\"keytool\" -exportcert -alias root-ca -keystore \"!install/auth/root-ca.jks\" -keypass !keypass -storepass !storepass -file \"!install/auth/root-ca.crt\" -rfc -ext ku:critical=cRLSign,keyCertSign -ext bc:critical=ca:true,pathlen:1"), "Exporting CA certificate: !install/auth/root-ca.crt") &&
            verifyExec(replaceVars("\"keytool\" -genkeypair -noprompt -alias qz-tray -keyalg RSA -keysize 2048 -dname \"CN=localhost, EMAILADDRESS=support@qz.io, OU=QZ Industries\\, LLC, O=QZ Industries\\, LLC, L=Canastota, S=NY, C=US\" -validity 7305 -keystore \"!install/auth/qz-tray.jks\" -storepass !storepass -keypass !keypass -ext ku:critical=digitalSignature,keyEncipherment -ext eku=serverAuth,clientAuth -ext san=dns:localhost,dns:localhost.qz.io -ext bc:critical=ca:false"), "Creating an SSL keypair: !install/auth/qz-tray.jks") &&
            verifyExec(replaceVars("\"keytool\" -certreq -keyalg RSA -alias qz-tray -file \"!install/auth/qz-tray.csr\" -keystore \"!install/auth/qz-tray.jks\" -keypass !keypass -storepass !storepass"), "Creating an SSL CSR: !install/auth/qz-tray.csr") &&
            verifyExec(replaceVars("\"keytool\" -keypass !keypass -storepass !storepass -validity 7305 -keystore \"!install/auth/root-ca.jks\" -gencert -alias root-ca -infile \"!install/auth/qz-tray.csr\" -ext ku:critical=digitalSignature,keyEncipherment -ext eku=serverAuth,clientAuth -ext san=dns:localhost,dns:localhost.qz.io -ext bc:critical=ca:false -rfc -outfile \"!install/auth/qz-tray.crt\""), "Issuing SSL certificate from CA: !install/auth/qz-tray.crt") &&
            verifyExec(replaceVars("\"keytool\" -noprompt -import -trustcacerts -alias root-ca -file \"!install/auth/root-ca.crt\" -keystore \"!install/auth/qz-tray.jks\" -keypass !keypass -storepass !storepass"), "Importing CA certificate into SSL keypair: !install/auth/qz-tray.crt") &&
            verifyExec(replaceVars("\"keytool\" -noprompt -import -trustcacerts -alias qz-tray -file \"!install/auth/qz-tray.crt\" -keystore \"!install/auth/qz-tray.jks\" -keypass !keypass -storepass !storepass"), "Importing chained SSL certificate into SSL keypair: !install/auth/root-ca.crt");

        deleteFile(fixPath("!install/auth/root-ca.jks"));
        deleteFile(fixPath("!install/auth/qz-tray.csr"));
        deleteFile(fixPath("!install/auth/qz-tray.crt"));
    }

    return success && writePropertiesFile();
}

/*
 * Writes !install/qz-tray.properties
 */
function writePropertiesFile() {
    console.log("Writing !install/qz-tray.properties...");

    // Handle "community" mode, custom signing auth cert
    var authCert = "" ? fixPath("!install/override.crt").replace(/\\/g, "\\\\") : "";

    try {
        var file = fso.OpenTextFile(fixPath("!install/qz-tray.properties"), 2, true);
        file.WriteLine("wss.alias=" + "qz-tray");
        file.WriteLine("wss.keystore=" + fixPath("!install/auth/qz-tray.jks").replace(/\\/g, "\\\\"));
        file.WriteLine("wss.keypass=" + pw());
        file.WriteLine("wss.storepass=" + pw());
        file.WriteLine("wss.host=0.0.0.0");
        file.Write(authCert ? "authcert.override=" + authCert + newLine : "");
        file.Close();
        console.log(" - [success] Writing SSL properties file: !install/qz-tray.properties");
        return true;
    } catch(err) {
        console.log(" - [failed] Error writing: !install/qz-tray.properties");
    }
}

/*
 * Exports certificate to native format
 */
function installWindowsCertificate() {
    console.log("Installing native certificate for secure websockets...");
    var success = verifyExec(replaceVars("certutil.exe -addstore -f \"Root\" \"!install/auth/root-ca.crt\""), "Installing native certificate") && findWindowsMatches("");
    if (success) {
        console.log(" - [success] Checking certificate installed");
    } else {
        throw "certutil.exe failed";
    }
}

function installWindowsXPCertificate() {
    shell.Popup("Automatic certificate installation is not available for this platform.\n" +
        "For secure websockets to function properly:\n\n" +
        "     1.  Navigate to \"" + fixPath("!install/auth/root-ca.crt") + "\"\n" +
        "     2.  Click \"Install Certificate...\"\n" +
        "     3.  Click \"Place all certificates in the following store\"\n" +
        "     4.  Browse to \"Trusted Root Certificate Authorities\"\n" +
        "     5.  Click \"Finish\"\n" +
        "     6.  Click \"Yes\" on thumbprint Security Warning\n\n" +
        "Click OK to automatically launch the certificate import wizard now.\n", 0, "Warning - QZ Tray", 48);

    // Do not wrap quotes around !install/auth/root-ca.crt, or this next line will fail
    shell.Run("rundll32.exe cryptext.dll,CryptExtAddCER " + fixPath("!install/auth/root-ca.crt"), 1, true);
}

/*
 * Gets the Firefox installation path, stores it a global variable "firefoxInstall"
 */
function getFirefoxInstall() {
    console.log("Searching for Firefox...");

    //  Use provided install directory, if supplied
    if (firefoxPortable) {
        firefoxInstall = firefoxPortable + "\\App\\Firefox\\firefox.exe";
        return firefoxInstall;
    }

    //  Determine if Firefox is installed
    var firefoxKey = "HKLM\\Software\\Mozilla\\Mozilla Firefox";
    var firefoxVer = getRegValue(firefoxKey + "\\");
    if (!firefoxVer) {
        // Look for Extended Support Release
        firefoxVer = getRegValue(firefoxKey + " ESR\\");
        if (firefoxVer) {
            firefoxVer += " ESR";
            console.log(" - [success] Found Firefox " + firefoxVer);
        }
        else {
            console.log(" - [skipped] Firefox was not detected");
            return false;
        }
    } else {
        console.log(" - [success] Found Firefox " + firefoxVer);
    }

    // Determine full path to firefox.exe, i.e. "C:\Program Files (x86)\Mozilla Firefox\firefox.exe"
    firefoxInstall = getRegValue(firefoxKey + " " + firefoxVer + "\\bin\\PathToExe");

    return firefoxInstall;
}

/*
 * Iterates over the installed preferences file looking for a non-QZ Tray AutoConfig rule
 */
function hasFirefoxConflict() {
    if (!getFirefoxInstall()) { return false; }

    console.log("Searching for Firefox AutoConfig conflicts...");
    // AutoConfig rule conflicts to search for
    var conflicts = ["general.config.filename"];

    // White-listed preference files, used for QZ Tray deployment
    var exceptions = ["firefox-prefs.js"];
    var folder = fso.GetFolder(firefoxInstall + "\\..\\defaults\\pref");
    var o = new Enumerator(folder.Files);
    for ( ; !o.atEnd(); o.moveNext()) {
        var whitelist = false;
        for (var i in exceptions) {
            if (exceptions[i] == o.item().Name) {
                console.log(" - [skipped] Writing QZ Tray config file: " + exceptions[i]);
                whitelist = true;
            }
        }
        if (!whitelist && parseFirefoxPref(o.item(), conflicts)) {
            return true;
        }
    }
    console.log(" - [success] No conflicts found");
    return false;
}

/*
 * Reads a Firefox preference file for already existing AutoConfig rule conflicts
 * Conflicts suggest an enterprise-type deployment environment.
 * Returns true if a conflict exists.
 */
function parseFirefoxPref(file, conflicts) {
    var inFile = fso.OpenTextFile(file.Path, 1, true);     // 1 = ForReading
    var counter = 0;
    while(!inFile.AtEndOfStream) {
        var line = inFile.ReadLine()
        counter++;
        for (var i in conflicts) {
            // Check for both quote styles, 'foo.bar.name' and "foo.bar.name"
            if (line.indexOf("'" + conflicts[i] + "'") >= 0 ||
                line.indexOf('"' + conflicts[i] + '"') >= 0) {
                console.log(" - [error] Conflict found in " + file.Name +
                    "\n\t Conflict on line " + counter + ": \"" + line + "\"");
                inFile.close();
                return true;
            }
        }
    }
    inFile.close();
    return false;
}


/*
 * Delete certificate for Mozilla Firefox browser, which utilizes its own cert database
 */
function deleteFirefoxCertificate() {
    if (!getFirefoxInstall()) { return; }

    console.log("Removing from Firefox...");
    var firefoxCfg = firefoxInstall + "\\..\\firefox-config.cfg";

    // Variable replacements for Firefox config file
    var replacements = {
        "${certData}" : "",
        "${uninstall}" : "true",
        "${timestamp}" : "-1",
        "${commonName}" : (cnOverride || "localhost"),
        "${trayApp}" : ""
    };

    // 1. readPlainCert() reads in certificate, stripping non-base64 content
    // 2. writeParsedConfig(...) reads, parses and writes config file in same folder as firefox.exe
    writeParsedConfig(fixPath("!install/auth/firefox/firefox-config.cfg"), firefoxCfg, replacements);
    verifyExists(firefoxCfg, "Firefox config exists");
}

/*
 * Install certificate for Mozilla Firefox browser, which utilizes its own cert database
 */
function installFirefoxCertificate() {
    if (!firefoxInstall) {
        console.log("Skipping Firefox cert install...");
        return;
    }
    console.log("Registering with Firefox...");
    var firefoxCfg = firefoxInstall + "\\..\\firefox-config.cfg";

    // Variable replacements for Firefox config file
    var replacements = {
        "${certData}" : readPlainCert(fixPath("!install/auth/root-ca.crt")),
        "${uninstall}" : "false",
        "${timestamp}" : new Date().getTime(),
        "${commonName}" : (cnOverride || "localhost"),
        "${trayApp}" : ""
    };

    // 1. readPlainCert() reads in certificate, stripping non-base64 content
    // 2. writeParsedConfig(...) reads, parses and writes config file in same folder as firefox.exe
    writeParsedConfig(fixPath("!install/auth/firefox/firefox-config.cfg"), firefoxCfg, replacements);
    verifyExists(firefoxCfg, "Checking Firefox config exists");

    // Install the preference file tells Firefox to launches firefox-config.cfg each time it starts
    var firefoxPrefs = firefoxInstall + "\\..\\defaults\\pref\\firefox-prefs.js";
    fso.CopyFile(fixPath("!install/auth/firefox/firefox-prefs.js"), firefoxPrefs);
}

/*
 * Convert Trusted SSL certificate to Java Keystore for use with secure websockets
 */
function createPKCS12() {
    var keyPair = fixPath("!install/auth/qz-tray.p12");

    var generated = "openssl pkcs12 -export -in \"!sslcert\" -inkey \"!sslkey\" -out \"!install/auth/qz-tray.p12\" -name qz-tray -passout pass:!keypass"
        .replace("!install/auth/qz-tray.p12", keyPair)
        .replace("!sslcert", trusted.cert)
        .replace("!sslkey", trusted.key)
        .replace("!keypass", pw());

    console.log("Creating PKCS12 keypair (this requires openssl)...");
    if (!verifyExec(generated, "Creating PKCS12 keypair")) {
        console.error("Error creating PKCS12 keypair from: " + trusted.cert + ", " + trusted.key + " to " + keyPair);
    }
}



/*
 * Deletes windows certificates based on specific CN and OU values
 */
function deleteWindowsCertificate() {
    console.log("Deleting old certificates...");
    var serialDelim = "||";
    var matches = findWindowsMatches(serialDelim);

    // If matches are found, delete them
    if (matches) {
        matches = matches.split(serialDelim);
        for (var i in matches) {
            if (matches[i]) {
                var success = verifyExec(replaceVars("certutil.exe -delstore \"Root\" \"!match\"").replaceAll("!match", matches[i]), 'Remove "QZ Industries, LLC" ' + matches[i] + ' certificate');
                if (!success) {
                    throw "certutil.exe failed";
                }
            }
        }

        // Verify removal
        matches = findWindowsMatches();
        if (matches) {
            console.log(" - [failed] Some certificates not deleted");
            return false;
        } else {
            console.log(" - [success] Certificate(s) removed");
        }
    } else {
        console.log(" - [skipped] No matches found");
    }
    return true;
}

/*
 * Certutil isn't available on Windows XP, show manual instructions instead
 */
function deleteWindowsXPCertificate() {
    shell.Popup("Automatic certificate deletion is not available for this platform.\n" +
        "To completely remove unused certificates:\n\n" +
        "     1.  Manage computer certificates\n" +
        "     2.  Click \"Trusted Root Certificate Authorities...\"\n" +
        "     3.  Click \"Certificates\"\n" +
        "     4.  Browse to \"localhost, QZ Industries, LLC\"\n" +
        "     5.  Right Click, \"Delete\"\n" +
        "Click OK to automatically launch the certificate manager.\n", 0, "Warning - QZ Tray", 48);

    shell.Run("mmc.exe certmgr.msc", 1, true);
}


/*
 * Returns matching serial numbers delimited by two pipes, i.e "9876fedc||1234abcd"
 */
function findWindowsMatches(serialDelim) {
    var matches = "";
    var proc = shell.Exec('certutil.exe -store "Root"');
    var certBlock = "";
    while (!proc.StdOut.AtEndOfStream) {
        var line = proc.StdOut.ReadLine()
        // Read certBlock in block sections
        if (line.indexOf("================") === -1) {
            certBlock += line + newLine;
        } else {
            var serial = parseCertificateSerial(certBlock);
            if (serial && isVendorMatch(certBlock)) {
                matches += serial + serialDelim;
            }
            certBlock = "";
        }
    }
    return matches;
}

/*
 * Parses the supplied data for serialTag
 * If found, returns the serial number of the certificate, i.e. "89e301a9"
 */
function parseCertificateSerial(certBlock) {
    // First line should have serial
    var lines = certBlock.split(newLine);
    if (lines.length > 0) {
        var serialParts = lines[0].split(":");
        if (serialParts.length > 0) {
            return trim(serialParts[1]);
        }
    }
    return false;
}

/*
 * Parses the supplied data for issuerTag
 * If found, parses the matched line for specific CN and OU values.
 * Returns true if found
 */
function isVendorMatch(certBlock) {
    // Second line should have issuer
    var lines = certBlock.split(newLine);
    if (lines.length > 0) {
        var issuerLine = lines[1];
        var i = issuerLine.indexOf(":") + 1;
        if (i > 1) {
            var issuer = trim(issuerLine.substring(i, issuerLine.length));
            return issuer.indexOf("OU=QZ Industries, LLC") !== -1 && issuer.indexOf("CN=" + (cnOverride || "localhost")) !== -1;
        }
    }
    return false;
}

/*
 * Functional equivalent of foo.trim()
 */
function trim(val) {
    return val ? val.replace(/^\s+/,'').replace(/\s+$/,'') : val;
}

/*
 * Parses a string to determine if it is an IPv4 address
 */
function isIp4(host) {
    var parts = host.split(".");
    var counter = 0;
    for (var i = 0; i < parts.length; i++) {
        if (isNaN(parseInt(parts[i]))) {
            return false;
        }
        counter++
    }
    return counter == 4;
}

/*
 * Gets then nth argument passed into this script
 * Returns defaultVal if argument wasn't found
 */
function getArg(index, defaultVal) {
    if (index >= WScript.Arguments.length || trim(WScript.Arguments(index)) == "") {
        return defaultVal;
    }
    return WScript.Arguments(index);
}

/*
 * Mimic an alert dialog, used only for OK_ONLY + WARNING (0 + 48), replaced with a console message if silent install
 */
function alert(message, title) {
    if (shell.Environment("PROCESS").Item("qz_silent")) {
        console.warn(message);
    } else {
        shell.Popup(message, 0, title == null ? "Warning" : title, 48);
    }
}