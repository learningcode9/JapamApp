package com.japamapp.mantrajapam

import android.app.Notification
import android.app.NotificationChannel
import android.util.Log
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicBoolean

class JapamTimerService : Service() {

    companion object {
        const val CHANNEL_ID = "japam_timer_v3"
        const val HEADS_UP_CHANNEL_ID = "japam_timer_heads_up"
        const val COMPLETION_CHANNEL_ID = "japam-complete"
        const val NOTIF_ID = 2001
        const val HEADS_UP_NOTIF_ID = 2003
        const val COMPLETION_NOTIF_ID = 2002
        const val PREFS = "JapamTimerState"

        const val ACTION_START = "com.japamapp.mantrajapam.TIMER_START"
        const val ACTION_PAUSE = "com.japamapp.mantrajapam.TIMER_PAUSE"
        const val ACTION_RESUME = "com.japamapp.mantrajapam.TIMER_RESUME"
        const val ACTION_STOP = "com.japamapp.mantrajapam.TIMER_STOP"
        const val ACTION_LOOP_COMPLETE = "com.japamapp.mantrajapam.LOOP_COMPLETE"

        const val EXTRA_DURATION = "durationSeconds"
        const val EXTRA_COMPLETED = "completedLoops"
        const val EXTRA_TOTAL = "totalLoops"
        const val EXTRA_SOUND = "soundEnabled"
        const val EXTRA_VIBRATION = "vibrationEnabled"
        const val EXTRA_USER_ID = "userId"
        const val EXTRA_STARTED_AT = "startedAt"

        @Volatile var isRunning = false
    }

    private val handler = Handler(Looper.getMainLooper())
    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null

    private var startedAt: Long = 0L
    private var pausedElapsedMs: Long = 0L
    private var durationMs: Long = 0L
    private var completedLoops: Int = 0
    private var totalLoops: Int = 1
    private var soundEnabled: Boolean = true
    private var vibrationEnabled: Boolean = true
    private var userId: String = ""
    private var isPaused: Boolean = false
    private val isCompleting = AtomicBoolean(false)
    private var lastSaveTime: Long = 0L
    private var startHeadsUpPosted: Boolean = false

    // Checks every second whether the timer has expired
    private val tickRunnable = object : Runnable {
        override fun run() {
            if (isPaused) return
            val now = System.currentTimeMillis()
            val remaining = durationMs - (now - startedAt)
            if (remaining <= 0 && isCompleting.compareAndSet(false, true)) {
                handleLoopComplete()
            } else if (remaining > 0) {
                if (now - lastSaveTime > 10_000) {
                    saveState()
                    lastSaveTime = now
                }
                handler.postDelayed(this, 1000L)
            }
        }
    }

    private val actionReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PAUSE -> doPause()
                ACTION_RESUME -> doResume()
                ACTION_STOP -> {
                    saveState()
                    @Suppress("DEPRECATION")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    } else {
                        stopForeground(true)
                    }
                    stopSelf()
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        Log.d("NativeTimer", "[NativeTimer] service started — JapamTimerService.onCreate()")
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(VIBRATOR_SERVICE) as Vibrator
        }
        createNotificationChannel()
        val filter = IntentFilter().apply {
            addAction(ACTION_PAUSE)
            addAction(ACTION_RESUME)
            addAction(ACTION_STOP)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(actionReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(actionReceiver, filter)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_START) {
            val durationSec = intent.getIntExtra(EXTRA_DURATION, 600)
            durationMs = durationSec * 1000L
            totalLoops = maxOf(1, intent.getIntExtra(EXTRA_TOTAL, 1))
            completedLoops = intent.getIntExtra(EXTRA_COMPLETED, 0).coerceIn(0, maxOf(0, totalLoops - 1))
            soundEnabled = intent.getBooleanExtra(EXTRA_SOUND, true)
            vibrationEnabled = intent.getBooleanExtra(EXTRA_VIBRATION, true)
            userId = intent.getStringExtra(EXTRA_USER_ID) ?: ""
            startedAt = intent.getLongExtra(EXTRA_STARTED_AT, System.currentTimeMillis())
            isPaused = false
            pausedElapsedMs = 0L
            isCompleting.set(false)

            loadSound()
            saveState()

            val remaining = maxOf(durationMs - (System.currentTimeMillis() - startedAt), 0L)
            // Android 14+ (API 34) requires the service type to be passed to startForeground().
            // Without it, SecurityException is thrown inside onStartCommand(), crashing the service
            // silently — the JS promise already resolved at that point.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIF_ID, buildNotification(remaining), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIF_ID, buildNotification(remaining))
            }
            Log.d("NativeTimer", "[NativeTimer] foreground notification posted: notifId=$NOTIF_ID remaining=${remaining}ms api=${Build.VERSION.SDK_INT}")
            postTimerStartedHeadsUp(remaining)

            handler.removeCallbacks(tickRunnable)
            handler.postDelayed(tickRunnable, 1000L)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        handler.removeCallbacks(tickRunnable)
        mediaPlayer?.release()
        mediaPlayer = null
        try { unregisterReceiver(actionReceiver) } catch (_: Exception) {}
        saveState()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Japam Timer",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Countdown timer for your Japam practice"
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)

            val headsUpChannel = NotificationChannel(
                HEADS_UP_CHANNEL_ID,
                "Timer Started",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Brief alert when your Japam timer starts"
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                enableVibration(false)
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(headsUpChannel)
        }
    }

    private fun buildNotification(remainingMs: Long): Notification {
        val mm = (remainingMs / 60_000).toInt()
        val ss = ((remainingMs % 60_000) / 1000).toInt()
        val timeStr = "%02d:%02d".format(mm, ss)
        val activeMala = (completedLoops + 1).coerceAtMost(totalLoops)
        val malaLabel = "Mala $activeMala / $totalLoops"

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val launchPi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val actionLabel = if (isPaused) "Resume" else "Pause"
        val actionIcon = if (isPaused) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause
        val actionBroadcast = if (isPaused) ACTION_RESUME else ACTION_PAUSE
        val actionPi = PendingIntent.getBroadcast(
            this, 1,
            Intent(actionBroadcast).setPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stopPi = PendingIntent.getBroadcast(
            this, 2,
            Intent(ACTION_STOP).setPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(malaLabel)
            .setContentText(if (isPaused) "Paused · $timeStr" else timeStr)
            .setContentIntent(launchPi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(actionIcon, actionLabel, actionPi)
            .addAction(android.R.drawable.ic_delete, "Stop", stopPi)

        if (!isPaused) {
            // Native system-driven countdown — no per-second notification updates needed
            builder
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setWhen(System.currentTimeMillis() + remainingMs)
                .setShowWhen(true)
        } else {
            builder.setShowWhen(false)
        }

        return builder.build()
    }

    private fun updateNotification(remainingMs: Long) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(remainingMs))
    }

    private fun postTimerStartedHeadsUp(remainingMs: Long) {
        if (startHeadsUpPosted) return
        startHeadsUpPosted = true

        val mm = (remainingMs / 60_000).toInt()
        val ss = ((remainingMs % 60_000) / 1000).toInt()
        val timeStr = "%02d:%02d".format(mm, ss)
        val activeMala = (completedLoops + 1).coerceAtMost(totalLoops)
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val launchPi = PendingIntent.getActivity(
            this, 4, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, HEADS_UP_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Japam timer started")
            .setContentText("Mala $activeMala / $totalLoops · $timeStr")
            .setContentIntent(launchPi)
            .setAutoCancel(true)
            .setOngoing(false)
            .setOnlyAlertOnce(false)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setTimeoutAfter(5_000L)
            .build()

        try {
            getSystemService(NotificationManager::class.java).notify(HEADS_UP_NOTIF_ID, notification)
            Log.d("NativeTimer", "[NativeTimer] timer started heads-up posted: notifId=$HEADS_UP_NOTIF_ID")
        } catch (error: SecurityException) {
            Log.w("NativeTimer", "[NativeTimer] timer started heads-up skipped: permission missing", error)
        } catch (error: Exception) {
            Log.w("NativeTimer", "[NativeTimer] timer started heads-up error", error)
        }
    }

    private fun postCompletionNotification(isFinal: Boolean) {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val launchPi = PendingIntent.getActivity(
            this, 3, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val title = if (isFinal) "Japam complete" else "Mala completed"
        val body = "Your Japam timer is complete"
        val notification = NotificationCompat.Builder(this, COMPLETION_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(launchPi)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()

        try {
            getSystemService(NotificationManager::class.java).notify(COMPLETION_NOTIF_ID, notification)
            Log.d("NativeTimer", "[COMPLETION_NATIVE] immediate notification posted notifId=$COMPLETION_NOTIF_ID isFinal=$isFinal")
        } catch (error: SecurityException) {
            Log.w("NativeTimer", "[COMPLETION_NATIVE] immediate notification skipped: permission missing", error)
        } catch (error: Exception) {
            Log.w("NativeTimer", "[COMPLETION_NATIVE] immediate notification error", error)
        }
    }

    private fun doPause() {
        if (isPaused) return
        isPaused = true
        pausedElapsedMs = System.currentTimeMillis() - startedAt
        handler.removeCallbacks(tickRunnable)
        val remaining = maxOf(durationMs - pausedElapsedMs, 0L)
        updateNotification(remaining)
        saveState()
    }

    private fun doResume() {
        if (!isPaused) return
        isPaused = false
        startedAt = System.currentTimeMillis() - pausedElapsedMs
        saveState()
        val remaining = maxOf(durationMs - (System.currentTimeMillis() - startedAt), 0L)
        updateNotification(remaining)
        handler.postDelayed(tickRunnable, 1000L)
    }

    private fun isAppActive(): Boolean =
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("appIsActive", false)

    private fun handleLoopComplete() {
        val remainingMs = maxOf(durationMs - (System.currentTimeMillis() - startedAt), 0L)
        // If app is in foreground, JS handles completion; native only updates notification
        if (isAppActive()) {
            Log.d(
                "NativeTimer",
                "[COMPLETION_NATIVE] skippedDuplicate=true reason=app-active remainingSeconds=${remainingMs / 1000} currentMala=${completedLoops + 1} targetMalaCount=$totalLoops"
            )
            isCompleting.set(false)
            return
        }

        if (completedLoops >= totalLoops) {
            Log.d(
                "NativeTimer",
                "[COMPLETION_NATIVE] skippedDuplicate=true reason=already-complete remainingSeconds=${remainingMs / 1000} currentMala=$completedLoops targetMalaCount=$totalLoops"
            )
            isCompleting.set(false)
            saveState()
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                stopForeground(true)
            }
            stopSelf()
            return
        }

        val newCompleted = (completedLoops + 1).coerceAtMost(totalLoops)
        completedLoops = newCompleted
        val isFinal = newCompleted >= totalLoops
        Log.d(
            "NativeTimer",
            "[COMPLETION_NATIVE] accepted remainingSeconds=${remainingMs / 1000} currentMala=$newCompleted targetMalaCount=$totalLoops durationMs=$durationMs isFinal=$isFinal"
        )

        saveState()

        postCompletionNotification(isFinal)

        if (vibrationEnabled) doVibrate()

        // Broadcast so native module can relay to JS if app wakes up
        sendBroadcast(Intent(ACTION_LOOP_COMPLETE).setPackage(packageName).apply {
            putExtra("completedLoops", newCompleted)
            putExtra("isFinal", isFinal)
            putExtra("userId", userId)
            putExtra("durationMs", durationMs)
        })

        handler.post {
            playOmSound {
                if (isFinal) {
                    isCompleting.set(false)
                    saveState()
                    @Suppress("DEPRECATION")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    } else {
                        stopForeground(true)
                    }
                    stopSelf()
                } else {
                    // Start next mala
                    startedAt = System.currentTimeMillis()
                    pausedElapsedMs = 0L
                    isCompleting.set(false)
                    saveState()
                    updateNotification(durationMs)
                    handler.postDelayed(tickRunnable, 1000L)
                }
            }
        }
    }

    private fun loadSound() {
        try {
            mediaPlayer?.release()
            val afd = resources.openRawResourceFd(R.raw.om_complete)
            mediaPlayer = MediaPlayer().apply {
                setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                afd.close()
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                prepare()
            }
        } catch (_: Exception) {
            // Sound file not available — vibration-only completion
            mediaPlayer = null
        }
    }

    private fun playOmSound(onComplete: () -> Unit) {
        val mp = mediaPlayer
        if (!soundEnabled || mp == null) {
            onComplete()
            return
        }
        try {
            var finished = false
            fun finishOnce() {
                if (finished) return
                finished = true
                mp.setOnCompletionListener(null)
                onComplete()
            }
            mp.seekTo(0)
            mp.setOnCompletionListener {
                finishOnce()
            }
            mp.start()
            // Fallback: call onComplete after 6s in case completion listener fires late
            handler.postDelayed({ finishOnce() }, 6_000L)
        } catch (_: Exception) {
            onComplete()
        }
    }

    private fun doVibrate() {
        val vib = vibrator ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vib.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 1200, 80, 1500), -1))
        } else {
            @Suppress("DEPRECATION")
            vib.vibrate(longArrayOf(0, 1200, 80, 1500), -1)
        }
    }

    private fun saveState() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            putBoolean("isRunning", isRunning && !isPaused)
            putBoolean("isPaused", isPaused)
            putLong("startedAt", startedAt)
            putLong("pausedElapsedMs", pausedElapsedMs)
            putLong("durationMs", durationMs)
            putInt("completedLoops", completedLoops)
            putInt("totalLoops", totalLoops)
            putBoolean("soundEnabled", soundEnabled)
            putBoolean("vibrationEnabled", vibrationEnabled)
            putString("userId", userId)
            apply()
        }
    }
}
