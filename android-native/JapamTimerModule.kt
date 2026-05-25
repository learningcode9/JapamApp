package com.japamapp.mantrajapam

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class JapamTimerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "JapamTimerService"

    private val loopCompleteReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != JapamTimerService.ACTION_LOOP_COMPLETE) return
            val params: WritableMap = Arguments.createMap().apply {
                putInt("completedLoops", intent.getIntExtra("completedLoops", 0))
                putBoolean("isFinal", intent.getBooleanExtra("isFinal", false))
                putString("userId", intent.getStringExtra("userId") ?: "")
                putDouble("durationMs", intent.getLongExtra("durationMs", 0L).toDouble())
            }
            sendEvent("japamTimerLoopComplete", params)
        }
    }

    override fun initialize() {
        super.initialize()
        Log.d("NativeTimer", "[NativeTimer] module loaded — JapamTimerModule initialized")
        val filter = IntentFilter(JapamTimerService.ACTION_LOOP_COMPLETE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(loopCompleteReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            reactContext.registerReceiver(loopCompleteReceiver, filter)
        }
    }

    override fun invalidate() {
        try { reactContext.unregisterReceiver(loopCompleteReceiver) } catch (_: Exception) {}
        super.invalidate()
    }

    private fun sendEvent(name: String, params: WritableMap?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, params)
    }

    @ReactMethod
    fun startTimer(
        durationSeconds: Int,
        completedLoops: Int,
        totalLoops: Int,
        soundEnabled: Boolean,
        vibrationEnabled: Boolean,
        userId: String,
        startedAt: Double,
        promise: Promise
    ) {
        Log.d("NativeTimer", "[NativeTimer] startTimer called: duration=${durationSeconds}s loops=$completedLoops/$totalLoops sound=$soundEnabled")
        try {
            val intent = Intent(reactContext, JapamTimerService::class.java).apply {
                action = JapamTimerService.ACTION_START
                putExtra(JapamTimerService.EXTRA_DURATION, durationSeconds)
                putExtra(JapamTimerService.EXTRA_COMPLETED, completedLoops)
                putExtra(JapamTimerService.EXTRA_TOTAL, totalLoops)
                putExtra(JapamTimerService.EXTRA_SOUND, soundEnabled)
                putExtra(JapamTimerService.EXTRA_VIBRATION, vibrationEnabled)
                putExtra(JapamTimerService.EXTRA_USER_ID, userId)
                putExtra(JapamTimerService.EXTRA_STARTED_AT, startedAt.toLong())
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
            Log.d("NativeTimer", "[NativeTimer] service started via startForegroundService/startService")
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("START_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun pauseTimer(promise: Promise) {
        try {
            reactContext.sendBroadcast(
                Intent(JapamTimerService.ACTION_PAUSE).setPackage(reactContext.packageName)
            )
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PAUSE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun resumeTimer(promise: Promise) {
        try {
            reactContext.sendBroadcast(
                Intent(JapamTimerService.ACTION_RESUME).setPackage(reactContext.packageName)
            )
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("RESUME_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopTimer(promise: Promise) {
        try {
            reactContext.sendBroadcast(
                Intent(JapamTimerService.ACTION_STOP).setPackage(reactContext.packageName)
            )
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STOP_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setAppActive(isActive: Boolean) {
        reactContext.getSharedPreferences(JapamTimerService.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean("appIsActive", isActive)
            .apply()
    }

    @ReactMethod
    fun getState(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences(JapamTimerService.PREFS, Context.MODE_PRIVATE)
            val result: WritableMap = Arguments.createMap().apply {
                putBoolean("isRunning", JapamTimerService.isRunning && prefs.getBoolean("isRunning", false))
                putBoolean("isPaused", prefs.getBoolean("isPaused", false))
                putDouble("startedAt", prefs.getLong("startedAt", 0L).toDouble())
                putDouble("pausedElapsedMs", prefs.getLong("pausedElapsedMs", 0L).toDouble())
                putDouble("durationMs", prefs.getLong("durationMs", 0L).toDouble())
                putInt("completedLoops", prefs.getInt("completedLoops", 0))
                putInt("totalLoops", prefs.getInt("totalLoops", 1))
                putString("userId", prefs.getString("userId", "") ?: "")
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("GET_STATE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun isServiceRunning(promise: Promise) {
        promise.resolve(JapamTimerService.isRunning)
    }

    // Required by RN event emitter protocol
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
