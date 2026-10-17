# Third-party notices

This integration ports to JavaScript part of the logic of the following
project: the request flow of DSM's Web API (API discovery through
`SYNO.API.Info`, the choice of the API version, the login parameters with the
device token of the 2-step verification, the renewal of a session refused with
error 119), the Surveillance Station calls (camera list, snapshot profiles,
enable / disable, Home Mode) and the error tables of DSM
(`src/synology/client.js`, `src/synology/errors.js`, `src/constants.js`).
Nothing of it is installed at runtime; its notice is reproduced below.

## py-synologydsm-api

<https://github.com/mib1185/py-synologydsm-api> (read at commit
`5c486c4`, 2026-10-10)

```
The MIT License (MIT)
Copyright (c) 2020 mib1185

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## LM1LC3N7/gladys-go2rtc and LM1LC3N7/gladys-frigate

The structure of the app, the camera images, the handler wiring and the
trust-on-first-use of a self-signed certificate follow integrations of the
same author, under the Apache License 2.0 of this repository. The test
certificates of `test/fixtures/tls/` come from gladys-frigate.
