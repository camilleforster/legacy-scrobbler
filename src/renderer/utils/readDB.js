const { open } = require('fs/promises')
const zlib = require('zlib')
const { promisify } = require('util')

const inflateRaw = promisify(zlib.inflateRaw)

function isCompressed (filePath) {
  return filePath.includes('iTunesCDB')
}

async function parseItunesDb (filePath) {
  let tracklist = []
  try {
    const handler = await open(filePath, 'r')

    if (isCompressed(filePath)) {
      tracklist = await parseCompressedItunesDb(handler)
    } else {
      tracklist = await parseUncompressedItunesDb(handler)
    }

    if (handler) {
      await handler.close()
    }
  } catch (error) {
    console.error('Error:', error)
    throw error
  }
  return tracklist
}

async function parseUncompressedItunesDb (handler) {
  let tracklist = []
  try {
    let totalBytesRead = 0
    const bufferSize = 1 * 1024 * 1024 // 1 MB buffer size
    const buffer = Buffer.alloc(bufferSize)

    while (true) {
      const bytesRead = await readBytesAtPosition(
        handler,
        buffer,
        totalBytesRead,
        bufferSize
      )
      await searchMhitInBuffer(buffer, bytesRead, tracklist, handler, totalBytesRead)
      
      totalBytesRead += bytesRead
      if (bytesRead < bufferSize) {
        break // End of file reached
      }
    }
  } catch (error) {
    console.error('Error in parseUncompressedItunesDb:', error)
  }
  return tracklist
}

async function parseCompressedItunesDb (handler) {
  let tracklist = []
  try {
    // Read MHBD header to get compressed data offset
    const headerBuffer = Buffer.alloc(4)
    await readBytesAtPosition(handler, headerBuffer, 0, 4)
    if (headerBuffer.toString('ascii') !== 'mhbd') {
      console.warn('Invalid MHBD header')
      return tracklist
    }

    // Read MHBD header size
    const mhbdHeaderBuffer = Buffer.alloc(4)
    await readBytesAtPosition(handler, mhbdHeaderBuffer, 4, 4)
    const mhbdHeaderSize = readUInt32LE(mhbdHeaderBuffer)


    // Read and decompress data
    const compressedData = Buffer.alloc(50 * 1024 * 1024) // 50MB buffer
    const bytesRead = await readBytesAtPosition(handler, compressedData, mhbdHeaderSize, 50 * 1024 * 1024)
    const deflateData = compressedData.slice(2, bytesRead) // Skip 2-byte zlib header

    let decompressed
    try {
      decompressed = await inflateRaw(deflateData)
    } catch (error) {
      console.error('[iTunesCDB] Decompression error:', error)
      throw error
    }


    // Parse decompressed data with proper structure (MHSD → MHLT → MHIT)
    tracklist = await parseDecompressedDatabase(decompressed)
  } catch (error) {
    console.error('Error in parseCompressedItunesDb:', error)
  }
  return tracklist
}

async function parseDecompressedDatabase (buffer) {
  const tracklist = []
  let pos = 0

  try {

    // Look for MHSD (dataset) containers
    while (pos < buffer.length - 8) {
      const marker = buffer.toString('ascii', pos, pos + 4)

      if (marker === 'mhsd') {
        const mhsdHeaderSize = readUInt32LE(buffer.slice(pos + 4, pos + 8))
        const mhsdTotalSize = readUInt32LE(buffer.slice(pos + 8, pos + 12))
        const datasetType = readUInt32LE(buffer.slice(pos + 12, pos + 16))


        if (datasetType === 1) {
          // Track list - skip to MHLT
          const mhltPos = pos + mhsdHeaderSize
          const tracks = await parseTrackList(buffer, mhltPos)
          tracklist.push(...tracks)
          break // We only need the track list
        }

        pos += mhsdTotalSize
      } else {
        pos += 1 // Move forward one byte and search again
      }
    }
  } catch (error) {
    console.error('[ParseDecompressed] Error:', error)
  }

  return tracklist
}

async function parseTrackList (buffer, startPos) {
  const tracklist = []

  try {
    let pos = startPos
    const marker = buffer.toString('ascii', pos, pos + 4)

    if (marker !== 'mhlt') {
      console.warn(`[ParseTrackList] Expected 'mhlt', got '${marker}'`)
      return tracklist
    }

    pos += 4
    const mhltHeaderSize = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4
    const numTracks = readUInt32LE(buffer.slice(pos, pos + 4))


    // Skip to first MHIT
    pos = startPos + mhltHeaderSize

    for (let i = 0; i < numTracks && pos < buffer.length; i++) {
      const track = await parseTrackFromBuffer(buffer, pos, i)
      if (track && track.track) {
        tracklist.push(track)
      } else {
      }

      // Move to next track
      const mhitTotalSize = readUInt32LE(buffer.slice(pos + 8, pos + 12))
      pos += mhitTotalSize
    }
  } catch (error) {
    console.error('[ParseTrackList] Error:', error)
  }

  return tracklist
}

async function parseTrackFromBuffer (buffer, trackStart, sequenceIndex) {
  try {
    const marker = buffer.toString('ascii', trackStart, trackStart + 4)
    if (marker !== 'mhit') {
      console.warn(`[ParseTrack] Expected 'mhit', got '${marker}' at ${trackStart}`)
      return null
    }

    let pos = trackStart + 4
    const mhitHeaderSize = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4
    const mhitTotalSize = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4
    const numMhods = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4

    // Read track ID (but use sequenceIndex instead for Play Counts matching)
    const trackId = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4

    // Skip 20 bytes to get to track length
    pos += 20

    // Read track length (in milliseconds) - offset 0x28 from start
    const trackLength = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4

    // Read play count - offset 0x50 from start (trackStart + 0x50)
    const playCountOffset = trackStart + 0x50
    const playCount = readUInt32LE(buffer.slice(playCountOffset, playCountOffset + 4))

    // Read last played time - offset 0x58 from start (Mac HFS timestamp)
    const lastPlayedOffset = trackStart + 0x58
    let lastPlayed = readUInt32LE(buffer.slice(lastPlayedOffset, lastPlayedOffset + 4))
    
    // Convert from Mac HFS epoch (Jan 1, 1904) to Unix epoch (Jan 1, 1970)
    if (lastPlayed > 0) {
      lastPlayed -= 2082844800
      // Adjust for timezone
      const tzOffset = new Date().getTimezoneOffset() * 60
      lastPlayed += tzOffset
    }

    const track = {
      track: '',
      artist: '',
      album: '',
      playCount: playCount,
      lastPlayed: lastPlayed,
      id: sequenceIndex,
      length: trackLength
    }

    // Skip to MHOD records
    let mhodPos = trackStart + mhitHeaderSize
    const mhitEnd = trackStart + mhitTotalSize

    for (let i = 0; i < numMhods && mhodPos < mhitEnd; i++) {
      const mhodSize = parseMhodFromBuffer(buffer, mhodPos, track)
      mhodPos += mhodSize
    }

    return track
  } catch (error) {
    console.error('[ParseTrack] Error:', error)
    return null
  }
}

function parseMhodFromBuffer (buffer, mhodStart, track) {
  try {
    const marker = buffer.toString('ascii', mhodStart, mhodStart + 4)
    if (marker !== 'mhod') {
      console.warn(`[ParseMhod] Expected 'mhod', got '${marker}' at ${mhodStart}`)
      return 4
    }

    let pos = mhodStart + 4
    const mhodHeaderSize = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4
    const mhodTotalSize = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4
    const mhodType = readUInt32LE(buffer.slice(pos, pos + 4))

    // Skip to string data after header
    pos = mhodStart + mhodHeaderSize

    if (pos + 16 > buffer.length) {
      return mhodTotalSize
    }

    const encodingCode = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4
    const strLen = readUInt32LE(buffer.slice(pos, pos + 4))
    pos += 4
    // Skip language and flags
    pos += 8


    if (strLen > 0 && strLen < 10000 && pos + strLen <= buffer.length) {
      let str
      if (encodingCode === 1) {
        // UTF-16LE
        str = buffer.toString('utf16le', pos, pos + strLen)
      } else {
        // UTF-8
        str = buffer.toString('utf8', pos, pos + strLen)
      }
      str = str.replace(/\0/g, '') // Remove null terminators


      switch (mhodType) {
        case 1:
          track.track = str
          break
        case 3:
          track.album = str
          break
        case 4:
          track.artist = str
          break
      }
    } else {
    }

    return mhodTotalSize
  } catch (error) {
    console.error('[ParseMhod] Error:', error)
    return 4
  }
}

async function searchMhitInBuffer (buffer, length, tracklist, handler, offset) {
  for (let i = 0; i < length - 4; i++) {
    if (buffer[i] === 109) { // 'm'
      const nextBytes = buffer.toString('utf8', i + 1, i + 4)
      if (nextBytes === 'hit') {
        const track = await parseMhit(handler, offset + i + 4)
        if (track && track.track) {
          tracklist.push(track)
        }
      }
    }
  }
}

async function readBytesAtPosition (handler, buffer, position, length) {
  try {
    const { bytesRead } = await handler.read(buffer, 0, length, position)

    return bytesRead
  } catch (error) {
    console.error('Error reading bytes at position:', error)
    throw error
  }
}

function readUInt32LE (buffer) {
  return buffer.readUInt32LE(0)
}

async function parseMhit (handler, startOffset) {
  const track = {}
  let bytesOffset = startOffset
  let totalSize = 0
  const dword = Buffer.alloc(4)

  await readBytesAtPosition(handler, dword, bytesOffset, 4)
  const headerSize = Number(littleEndianToBigInt(dword))
  bytesOffset += 4
  bytesOffset += 4 // Skip 4 bytes

  await readBytesAtPosition(handler, dword, bytesOffset, 4)
  const mhodEntriesCount = Number(littleEndianToBigInt(dword))
  bytesOffset += 4

  await readBytesAtPosition(handler, dword, bytesOffset, 4)
  track.id = Number(littleEndianToBigInt(dword))
  bytesOffset += 4
  bytesOffset += 20 // Skip 20 bytes

  await readBytesAtPosition(handler, dword, bytesOffset, 4)
  track.length = Number(littleEndianToBigInt(dword))
  bytesOffset += 4

  for (let i = 0; i < mhodEntriesCount; ++i) {
    totalSize = await parsemhod(track, handler, startOffset, headerSize)
    startOffset += totalSize
  }
  return track
}

async function parsemhod (track, handler, startOffset, headerSize) {
  let bytesOffset = startOffset + headerSize - 4
  const dword = Buffer.alloc(4)

  bytesOffset += 8

  await readBytesAtPosition(handler, dword, bytesOffset, 4)
  const totalSizeValue = Number(littleEndianToBigInt(dword))
  bytesOffset += 4

  await readBytesAtPosition(handler, dword, bytesOffset, 4)
  const mhodTypeValue = Number(littleEndianToBigInt(dword))
  bytesOffset += 4

  if (mhodTypeValue === 1 || mhodTypeValue === 3 || mhodTypeValue === 4) {
    bytesOffset += 12

    await readBytesAtPosition(handler, dword, bytesOffset, 4)
    const stringLengthValue = Number(littleEndianToBigInt(dword))
    bytesOffset += 12

    if (stringLengthValue > 0 && stringLengthValue < 10000) {
      const dataArray = Buffer.alloc(stringLengthValue)
      await readBytesAtPosition(handler, dataArray, bytesOffset, stringLengthValue)
      const stringData = dataArray.toString('utf16le')

      switch (mhodTypeValue) {
        case 1:
          track.track = stringData
          break
        case 3:
          track.album = stringData
          break
        case 4:
          track.artist = stringData
          break
      }
    }
  }
  return totalSizeValue
}

// Function to convert little endian byte array to big endian
function littleEndianToBigInt (byteArray) {
  let bigEndianBytes = Buffer.alloc(byteArray.length)
  for (let i = 0; i < byteArray.length; i++) {
    bigEndianBytes[i] = byteArray[byteArray.length - i - 1]
  }
  return BigInt('0x' + bigEndianBytes.toString('hex'))
}

async function parsePlayCounts (filePath, tracklist) {
  try {

    const handler = await open(filePath, 'r')

    let bytesOffset = 0

    bytesOffset += 8 // Skip 8 bytes
    const dword = Buffer.alloc(4)

    const entryLenArray = await readBytesAtPosition(
      handler,
      dword,
      bytesOffset,
      4
    )
    const entryLen = Number(littleEndianToBigInt(dword))

    bytesOffset += 4

    const numEntriesArray = await readBytesAtPosition(
      handler,
      dword,
      bytesOffset,
      4
    )
    const numEntries = Number(littleEndianToBigInt(dword))

    bytesOffset += 4

    bytesOffset += 80

    let tracksWithPlays = 0

    for (let i = 0; i < numEntries - 1; i++) {
      let lastPlayedCollection = []
      let savedBytes = bytesOffset
      const playCountArray = await readBytesAtPosition(
        handler,
        dword,
        bytesOffset,
        4
      )
      const playCount = Number(littleEndianToBigInt(dword))
      bytesOffset += 4

      if (playCount > 0) {
        const lastPlayedArray = await readBytesAtPosition(
          handler,
          dword,
          bytesOffset,
          4
        )

        let lastPlayed = Number(littleEndianToBigInt(dword))
        bytesOffset += 4

        lastPlayed -= 2082844800

        var offset = new Date().getTimezoneOffset() * 60
        lastPlayed += offset

        // CRITICAL FIX: Match by ID instead of array index, because compressed and uncompressed formats
        // may have different track ordering. The Play Counts file uses a fixed index order that doesn't
        // match the order returned by the compressed parser.
        const trackIndex = tracklist.findIndex(t => t.id === i)
        if (trackIndex !== -1) {
          tracklist[trackIndex].playCount = playCount
          tracklist[trackIndex].lastPlayed = lastPlayed
          tracksWithPlays++
        } else {
          // No matching track found for this play count index
        }
      }

      bytesOffset = savedBytes + entryLen
    }
    if (handler) {
      await handler.close()
    }
  } catch (error) {
    console.error('Error:', error)
  }
}

async function findItunesDbFile (path) {
  const fs = require('fs/promises')
  try {
    await fs.access(path + 'iTunesCDB')
    return path + 'iTunesCDB'
  } catch {
    return path + 'iTunesDB'
  }
}

export async function getRecentTracks (path) {
  const iTunesDbPath = await findItunesDbFile(path)
  const playCountsPath = path + 'Play Counts'
  const tracklist = await parse(iTunesDbPath, playCountsPath)

  const recentPlays = tracklist.filter(
    entry => entry.playCount && entry.playCount > 0
  )
  recentPlays.sort((a, b) => b.lastPlayed - a.lastPlayed)
  
  // Log tracks with plays
  console.log(`\n🎵 Found ${recentPlays.length} tracks with plays:\n`)
  recentPlays.forEach((track, index) => {
    const lastPlayedDate = new Date(track.lastPlayed * 1000).toLocaleString()
    console.log(`${index + 1}. "${track.track}" by ${track.artist || 'Unknown Artist'}`)
    console.log(`   Album: ${track.album || 'Unknown Album'} | Plays: ${track.playCount} | Last Played: ${lastPlayedDate}\n`)
  })
  
  return recentPlays
}

export async function parse (iTunesDbPath, playCountsPath) {
  const tracklist = await parseItunesDb(iTunesDbPath)
  
  // Only read Play Counts file for uncompressed iTunesDB format
  // Compressed iTunesCDB stores play counts directly in the database
  if (!isCompressed(iTunesDbPath)) {
    await parsePlayCounts(playCountsPath, tracklist)
  }
  
  return tracklist
}
