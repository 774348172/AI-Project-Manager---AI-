package com.baize.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.text.method.PasswordTransformationMethod;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.content.FileProvider;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String KEY_TOKEN = "token";
    private static final String KEY_USERNAME = "username";
    private static final String DEFAULT_SERVER_URL = "https://baize.baizerobotai.site";
    private static final int RECORD_AUDIO_PERMISSION_REQUEST_CODE = 1001;
    private static final int SPEECH_SAMPLE_RATE = 16000;
    private static final int MAX_RECORDING_MS = 15000;
    private static final int GREEN = 0xFF07C160;
    private static final int TEXT = 0xFF111111;
    private static final int MUTED = 0xFF7A7A7A;
    private static final int BACKGROUND = 0xFFEDEDED;
    private static final int PANEL = 0xFFF7F7F7;
    private static final int BUBBLE_ME = 0xFF95EC69;
    private static final int BUBBLE_BAIZE = 0xFFFFFFFF;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private String serverUrl;
    private String token;
    private String username;
    private String accountJiraDefaultProjectKey;
    private String accountJiraUsername;
    private String conversationId;
    private String clientId;
    private JSONObject updateStatus;
    private File pendingUpdateApk;
    private boolean registerMode;
    private boolean updateBusy;
    private boolean settingsExpanded;

    private LinearLayout authRoot;
    private EditText usernameInput;
    private EditText passwordInput;
    private EditText confirmPasswordInput;
    private TextView authTitle;
    private TextView authDescription;
    private TextView authStatus;
    private TextView authUpdateStatus;
    private Button authUpdateButton;
    private Button authSubmitButton;
    private Button authSwitchButton;
    private ProgressBar authProgress;

    private LinearLayout chatRoot;
    private TextView accountText;
    private Button settingsToggleButton;
    private LinearLayout settingsPanel;
    private EditText accountJiraDefaultProjectInput;
    private EditText accountJiraUsernameInput;
    private Button saveAccountJiraDefaultsButton;
    private LinearLayout messagesLayout;
    private ScrollView messagesScroll;
    private EditText chatInput;
    private ImageButton voiceButton;
    private Button sendButton;
    private TextView chatUpdateStatus;
    private Button chatUpdateButton;
    private TextView chatStatus;
    private volatile boolean recording;
    private AudioRecord audioRecord;
    private ByteArrayOutputStream recordingBuffer;
    private long recordingStartedAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        clientId = readClientId();
        serverUrl = DEFAULT_SERVER_URL;
        token = getPreferences(MODE_PRIVATE).getString(KEY_TOKEN, null);
        username = getPreferences(MODE_PRIVATE).getString(KEY_USERNAME, null);
        showAuthScreen("正在检查登录状态。", true);
        checkForUpdate();
        if (token != null && !token.trim().isEmpty()) {
            validateToken();
        } else {
            showAuthScreen("请输入账号和密码。", false);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pendingUpdateApk != null && pendingUpdateApk.exists() && getPackageManager().canRequestPackageInstalls()) {
            File apkFile = pendingUpdateApk;
            pendingUpdateApk = null;
            installApk(apkFile);
        }
    }

    @Override
    protected void onDestroy() {
        if (recording) {
            recording = false;
        }
        if (audioRecord != null) {
            audioRecord.release();
            audioRecord = null;
        }
        executor.shutdownNow();
        super.onDestroy();
    }

    private String readClientId() {
        String id = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        return id == null || id.trim().isEmpty() ? "android-device" : "android-" + id;
    }

    private void validateToken() {
        runAsync(new Task() {
            @Override
            public void run() throws Exception {
                JSONObject data = request("GET", "/auth/me", null, token);
                JSONObject user = data.optJSONObject("user");
                applyUser(user, username);
                saveSession();
                runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        showChatScreen();
                    }
                });
            }
        }, new ErrorHandler() {
            @Override
            public void onError(final Exception error) {
                clearSession();
                showAuthScreen(messageOf(error), false);
            }
        });
    }

    private void showAuthScreen(String message, boolean loading) {
        if (authRoot == null) {
            buildAuthScreen();
        }
        renderAuthMode();
        authStatus.setText(message == null ? defaultAuthMessage() : message);
        setAuthLoading(loading);
        renderUpdateStatus();
        setContentView(authRoot);
    }

    private void buildAuthScreen() {
        authRoot = new LinearLayout(this);
        authRoot.setOrientation(LinearLayout.VERTICAL);
        authRoot.setGravity(Gravity.CENTER_HORIZONTAL);
        authRoot.setPadding(dp(24), dp(42), dp(24), dp(24));
        authRoot.setBackgroundColor(BACKGROUND);

        TextView brand = new TextView(this);
        brand.setText("白泽账号");
        brand.setTextColor(GREEN);
        brand.setTextSize(14);
        brand.setGravity(Gravity.CENTER_HORIZONTAL);
        authRoot.addView(brand, matchWrap());

        authTitle = new TextView(this);
        authTitle.setTextColor(TEXT);
        authTitle.setTextSize(30);
        authTitle.setGravity(Gravity.CENTER_HORIZONTAL);
        authTitle.setPadding(0, dp(8), 0, 0);
        authRoot.addView(authTitle, matchWrap());

        authDescription = new TextView(this);
        authDescription.setTextColor(MUTED);
        authDescription.setTextSize(14);
        authDescription.setGravity(Gravity.CENTER_HORIZONTAL);
        authDescription.setPadding(0, dp(8), 0, dp(20));
        authRoot.addView(authDescription, matchWrap());

        usernameInput = createInput("账号", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL);
        usernameInput.setSingleLine(true);
        usernameInput.setImeOptions(EditorInfo.IME_ACTION_NEXT);
        usernameInput.setPrivateImeOptions(null);
        authRoot.addView(usernameInput, matchWrap(dp(8)));

        passwordInput = createInput("密码", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passwordInput.setSingleLine(true);
        passwordInput.setTransformationMethod(PasswordTransformationMethod.getInstance());
        authRoot.addView(passwordInput, matchWrap(dp(8)));

        confirmPasswordInput = createInput("确认密码", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        confirmPasswordInput.setSingleLine(true);
        confirmPasswordInput.setTransformationMethod(PasswordTransformationMethod.getInstance());
        authRoot.addView(confirmPasswordInput, matchWrap(dp(8)));

        authSubmitButton = new Button(this);
        authSubmitButton.setTextColor(0xFFFFFFFF);
        authSubmitButton.setBackgroundColor(GREEN);
        authSubmitButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                submitAuth();
            }
        });
        authRoot.addView(authSubmitButton, matchWrap(dp(12)));

        authSwitchButton = new Button(this);
        authSwitchButton.setTextColor(GREEN);
        authSwitchButton.setBackgroundColor(0x00000000);
        authSwitchButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                registerMode = !registerMode;
                renderAuthMode();
                authStatus.setText(defaultAuthMessage());
            }
        });
        authRoot.addView(authSwitchButton, matchWrap(dp(4)));

        authUpdateStatus = new TextView(this);
        authUpdateStatus.setTextColor(MUTED);
        authUpdateStatus.setTextSize(13);
        authUpdateStatus.setGravity(Gravity.CENTER_HORIZONTAL);
        authRoot.addView(authUpdateStatus, matchWrap(dp(4)));

        authUpdateButton = new Button(this);
        authUpdateButton.setText("下载更新");
        authUpdateButton.setTextColor(GREEN);
        authUpdateButton.setVisibility(View.GONE);
        authUpdateButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                downloadAndInstallUpdate();
            }
        });
        authRoot.addView(authUpdateButton, matchWrap(dp(8)));

        authProgress = new ProgressBar(this);
        authRoot.addView(authProgress, wrapCenter(dp(8)));

        authStatus = new TextView(this);
        authStatus.setTextColor(MUTED);
        authStatus.setTextSize(13);
        authStatus.setGravity(Gravity.CENTER_HORIZONTAL);
        authStatus.setPadding(0, dp(10), 0, 0);
        authRoot.addView(authStatus, matchWrap());
    }

    private void renderAuthMode() {
        boolean isRegister = registerMode;
        authTitle.setText(isRegister ? "注册" : "登录");
        authDescription.setText(isRegister ? "创建账号后，Windows 和 Android 都可以用这个账号登录。" : "登录后可在 Windows 和 Android 共用同一个白泽账号。");
        confirmPasswordInput.setVisibility(isRegister ? View.VISIBLE : View.GONE);
        authSubmitButton.setText(isRegister ? "注册并登录" : "登录");
        authSwitchButton.setText(isRegister ? "返回登录" : "注册账号");
    }

    private String defaultAuthMessage() {
        return registerMode ? "请输入账号和两次密码。" : "请输入账号和密码。";
    }

    private void submitAuth() {
        if (isUpdateRequired()) {
            authStatus.setText("当前版本必须更新后才能继续使用。");
            return;
        }
        final String nextUsername = usernameInput.getText().toString().trim();
        final String password = passwordInput.getText().toString();
        final String confirmPassword = confirmPasswordInput.getText().toString();

        if (nextUsername.length() < 3 || nextUsername.length() > 32) {
            authStatus.setText("用户名只能使用 3-32 位字母、数字、下划线或短横线。");
            return;
        }
        if (password.length() < 6 || password.length() > 64) {
            authStatus.setText("密码长度必须是 6-64 位。");
            return;
        }
        if (registerMode && !password.equals(confirmPassword)) {
            authStatus.setText("两次输入的密码不一致。");
            return;
        }

        serverUrl = cleanServerUrl(serverUrl);
        setAuthLoading(true);
        authStatus.setText(registerMode ? "正在注册。" : "正在登录。");
        runAsync(new Task() {
            @Override
            public void run() throws Exception {
                JSONObject body = new JSONObject();
                body.put("username", nextUsername);
                body.put("password", password);
                body.put("platform", "android");
                body.put("deviceId", clientId);
                body.put("clientVersion", getAppVersionName());

                JSONObject data = request("POST", registerMode ? "/auth/register" : "/auth/login", body, null);
                token = data.optString("token", null);
                JSONObject user = data.optJSONObject("user");
                applyUser(user, nextUsername);
                saveSession();
                runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        passwordInput.setText("");
                        confirmPasswordInput.setText("");
                        showChatScreen();
                    }
                });
            }
        }, new ErrorHandler() {
            @Override
            public void onError(Exception error) {
                setAuthLoading(false);
                authStatus.setText(messageOf(error));
            }
        });
    }

    private void setAuthLoading(boolean loading) {
        if (authSubmitButton != null) {
            authSubmitButton.setEnabled(!loading);
            authSwitchButton.setEnabled(!loading);
            authProgress.setVisibility(loading ? View.VISIBLE : View.GONE);
        }
    }

    private void showChatScreen() {
        if (chatRoot == null) {
            buildChatScreen();
        }
        accountText.setText(username == null ? "已登录" : username);
        renderSettingsPanel();
        renderAccountJiraDefaults();
        renderUpdateStatus();
        chatStatus.setText("");
        if (messagesLayout.getChildCount() == 0) {
            addMessage("白泽", "你可以开始和白泽对话。");
        }
        setContentView(chatRoot);
    }

    private void buildChatScreen() {
        chatRoot = new LinearLayout(this);
        chatRoot.setOrientation(LinearLayout.VERTICAL);
        chatRoot.setBackgroundColor(BACKGROUND);
        chatRoot.setPadding(0, dp(22), 0, 0);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(8), dp(10), dp(8));
        header.setBackgroundColor(PANEL);
        chatRoot.addView(header, matchWrap());

        TextView title = new TextView(this);
        title.setText("白泽");
        title.setTextColor(TEXT);
        title.setTextSize(18);
        title.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        settingsToggleButton = new Button(this);
        settingsToggleButton.setText("设置");
        settingsToggleButton.setTextColor(GREEN);
        settingsToggleButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                settingsExpanded = !settingsExpanded;
                renderSettingsPanel();
            }
        });
        header.addView(settingsToggleButton, wrapWrap());

        chatUpdateStatus = new TextView(this);
        chatUpdateStatus.setTextColor(MUTED);
        chatUpdateStatus.setTextSize(13);
        chatRoot.addView(chatUpdateStatus, matchWrap(dp(4)));

        chatUpdateButton = new Button(this);
        chatUpdateButton.setText("下载更新");
        chatUpdateButton.setTextColor(GREEN);
        chatUpdateButton.setVisibility(View.GONE);
        chatUpdateButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                downloadAndInstallUpdate();
            }
        });
        chatRoot.addView(chatUpdateButton, matchWrap(dp(8)));

        settingsPanel = new LinearLayout(this);
        settingsPanel.setOrientation(LinearLayout.VERTICAL);
        settingsPanel.setBackgroundColor(0xFFFFFFFF);
        settingsPanel.setPadding(dp(12), dp(10), dp(12), dp(10));
        chatRoot.addView(settingsPanel, matchWrap(dp(8)));

        accountText = new TextView(this);
        accountText.setTextColor(TEXT);
        accountText.setTextSize(14);
        settingsPanel.addView(accountText, matchWrap(dp(8)));

        TextView defaultsTitle = new TextView(this);
        defaultsTitle.setText("Jira 默认配置（跟随白泽账号）");
        defaultsTitle.setTextColor(TEXT);
        defaultsTitle.setTextSize(15);
        defaultsTitle.setPadding(0, dp(4), 0, dp(4));
        settingsPanel.addView(defaultsTitle, matchWrap());

        accountJiraDefaultProjectInput = createInput("默认项目", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL);
        accountJiraDefaultProjectInput.setSingleLine(true);
        settingsPanel.addView(accountJiraDefaultProjectInput, matchWrap(dp(8)));

        accountJiraUsernameInput = createInput("Jira 用户", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL);
        accountJiraUsernameInput.setSingleLine(true);
        settingsPanel.addView(accountJiraUsernameInput, matchWrap(dp(8)));

        LinearLayout settingsActions = new LinearLayout(this);
        settingsActions.setOrientation(LinearLayout.HORIZONTAL);
        settingsActions.setGravity(Gravity.CENTER_VERTICAL);
        settingsPanel.addView(settingsActions, matchWrap());

        saveAccountJiraDefaultsButton = new Button(this);
        saveAccountJiraDefaultsButton.setText("保存 Jira 配置");
        saveAccountJiraDefaultsButton.setTextColor(GREEN);
        saveAccountJiraDefaultsButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                saveAccountJiraDefaults();
            }
        });
        settingsActions.addView(saveAccountJiraDefaultsButton, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        Button logoutButton = new Button(this);
        logoutButton.setText("退出账号");
        logoutButton.setTextColor(GREEN);
        logoutButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                logout();
            }
        });
        settingsActions.addView(logoutButton, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        messagesScroll = new ScrollView(this);
        messagesScroll.setFillViewport(true);
        messagesLayout = new LinearLayout(this);
        messagesLayout.setOrientation(LinearLayout.VERTICAL);
        messagesLayout.setPadding(dp(12), dp(12), dp(12), dp(12));
        messagesScroll.addView(messagesLayout, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
        chatRoot.addView(messagesScroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));

        chatStatus = new TextView(this);
        chatStatus.setTextColor(MUTED);
        chatStatus.setTextSize(12);
        chatStatus.setGravity(Gravity.CENTER_HORIZONTAL);
        chatStatus.setPadding(dp(8), dp(4), dp(8), dp(4));
        chatRoot.addView(chatStatus, matchWrap());

        LinearLayout composer = new LinearLayout(this);
        composer.setOrientation(LinearLayout.HORIZONTAL);
        composer.setGravity(Gravity.CENTER_VERTICAL);
        composer.setPadding(dp(8), dp(6), dp(8), dp(6));
        composer.setBackgroundColor(PANEL);
        chatRoot.addView(composer, matchWrap());

        chatInput = createInput("输入消息", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        chatInput.setSingleLine(false);
        chatInput.setMinLines(1);
        chatInput.setMaxLines(4);
        chatInput.setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        chatInput.setBackground(roundRect(0xFFFFFFFF, dp(4)));
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        inputParams.setMargins(0, 0, dp(6), 0);
        composer.addView(chatInput, inputParams);

        voiceButton = new ImageButton(this);
        voiceButton.setImageResource(R.drawable.ic_mic);
        voiceButton.setBackgroundColor(0x00000000);
        voiceButton.setPadding(dp(10), dp(8), dp(10), dp(8));
        voiceButton.setScaleType(ImageButton.ScaleType.CENTER_INSIDE);
        voiceButton.setContentDescription("语音输入");
        voiceButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                toggleVoiceInput();
            }
        });
        composer.addView(voiceButton, new LinearLayout.LayoutParams(dp(44), dp(40)));

        sendButton = new Button(this);
        sendButton.setText("发送");
        sendButton.setTextColor(0xFFFFFFFF);
        sendButton.setTextSize(14);
        sendButton.setBackground(roundRect(GREEN, dp(4)));
        sendButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                sendChat();
            }
        });
        composer.addView(sendButton, new LinearLayout.LayoutParams(dp(66), dp(40)));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != RECORD_AUDIO_PERMISSION_REQUEST_CODE) {
            return;
        }
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startVoiceRecording();
        } else {
            chatStatus.setText("需要麦克风权限才能使用语音输入。");
        }
    }

    private void toggleVoiceInput() {
        if (recording) {
            stopVoiceRecording();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, RECORD_AUDIO_PERMISSION_REQUEST_CODE);
            return;
        }
        startVoiceRecording();
    }

    private void startVoiceRecording() {
        int minBufferSize = AudioRecord.getMinBufferSize(SPEECH_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBufferSize <= 0) {
            chatStatus.setText("当前设备无法初始化麦克风录音。");
            return;
        }
        recordingBuffer = new ByteArrayOutputStream();
        recordingStartedAt = System.currentTimeMillis();
        audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, SPEECH_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBufferSize * 2);
        audioRecord.startRecording();
        recording = true;
        voiceButton.setImageResource(android.R.drawable.ic_media_pause);
        sendButton.setEnabled(false);
        chatStatus.setText("正在录音，再点一次停止。");
        final int readSize = minBufferSize;
        executor.execute(new Runnable() {
            @Override
            public void run() {
                byte[] buffer = new byte[readSize];
                while (recording && System.currentTimeMillis() - recordingStartedAt < MAX_RECORDING_MS) {
                    int bytesRead = audioRecord.read(buffer, 0, buffer.length);
                    if (bytesRead > 0 && recordingBuffer != null) {
                        recordingBuffer.write(buffer, 0, bytesRead);
                    }
                }
                if (recording) {
                    runOnMain(new Runnable() {
                        @Override
                        public void run() {
                            stopVoiceRecording();
                        }
                    });
                }
            }
        });
    }

    private void stopVoiceRecording() {
        if (!recording) {
            return;
        }
        recording = false;
        final byte[] audioBytes = recordingBuffer == null ? new byte[0] : recordingBuffer.toByteArray();
        final long durationMs = Math.max(0, System.currentTimeMillis() - recordingStartedAt);
        if (audioRecord != null) {
            audioRecord.stop();
            audioRecord.release();
            audioRecord = null;
        }
        voiceButton.setImageResource(R.drawable.ic_mic);
        if (audioBytes.length == 0) {
            sendButton.setEnabled(true);
            chatStatus.setText("没有录到声音，请重试。");
            return;
        }
        transcribeVoice(audioBytes, durationMs);
    }

    private void transcribeVoice(final byte[] audioBytes, final long durationMs) {
        voiceButton.setEnabled(false);
        sendButton.setEnabled(false);
        chatStatus.setText("正在识别语音。");
        runAsync(new Task() {
            @Override
            public void run() throws Exception {
                JSONObject body = new JSONObject();
                body.put("audioBase64", android.util.Base64.encodeToString(audioBytes, android.util.Base64.NO_WRAP));
                body.put("format", "pcm");
                body.put("sampleRate", SPEECH_SAMPLE_RATE);
                body.put("durationMs", durationMs);
                body.put("platform", "android");
                body.put("clientId", clientId);

                JSONObject data = request("POST", "/speech/transcribe", body, token);
                final String recognizedText = data.optString("text", "").trim();
                runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        voiceButton.setEnabled(true);
                        sendButton.setEnabled(true);
                        if (recognizedText.isEmpty()) {
                            chatStatus.setText("没有识别到文字，请重试。");
                            return;
                        }
                        appendChatInput(recognizedText);
                        chatStatus.setText("语音识别已完成。");
                    }
                });
            }
        }, new ErrorHandler() {
            @Override
            public void onError(Exception error) {
                voiceButton.setEnabled(true);
                sendButton.setEnabled(true);
                chatStatus.setText(messageOf(error));
            }
        });
    }

    private void appendChatInput(String text) {
        String currentText = chatInput == null ? "" : chatInput.getText().toString();
        String separator = currentText.trim().isEmpty() ? "" : " ";
        chatInput.setText(currentText + separator + text);
        chatInput.setSelection(chatInput.getText().length());
    }

    private void checkForUpdate() {
        runAsync(new Task() {
            @Override
            public void run() throws Exception {
                String version = getAppVersionName();
                JSONObject data = request("GET", "/client/version?platform=android&version=" + urlEncode(version), null, null);
                updateStatus = data;
                runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        renderUpdateStatus();
                    }
                });
            }
        }, new ErrorHandler() {
            @Override
            public void onError(Exception error) {
                updateStatus = null;
                renderUpdateStatus();
            }
        });
    }

    private String getAppVersionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "0.0.0" : info.versionName;
        } catch (Exception error) {
            return "0.0.0";
        }
    }

    private String urlEncode(String value) throws Exception {
        return java.net.URLEncoder.encode(value == null ? "" : value, "UTF-8");
    }

    private boolean isUpdateRequired() {
        return updateStatus != null && updateStatus.optBoolean("updateRequired", false);
    }

    private void renderUpdateStatus() {
        boolean available = updateStatus != null && updateStatus.optBoolean("updateAvailable", false);
        boolean required = isUpdateRequired();
        String currentVersion = updateStatus == null ? "" : updateStatus.optString("currentVersion", "");
        String releaseNotes = updateStatus == null ? "" : updateStatus.optString("releaseNotes", "").trim();
        String message = available
            ? (required ? "发现强制更新 " : "发现新版本 ") + currentVersion + (releaseNotes.isEmpty() ? "" : "\n" + releaseNotes)
            : "";

        if (authUpdateStatus != null) {
            authUpdateStatus.setText(message);
            authUpdateStatus.setVisibility(available ? View.VISIBLE : View.GONE);
        }
        if (authUpdateButton != null) {
            authUpdateButton.setVisibility(available ? View.VISIBLE : View.GONE);
            authUpdateButton.setEnabled(!updateBusy);
            authUpdateButton.setText(updateBusy ? "下载中" : "下载更新");
        }
        if (chatUpdateStatus != null) {
            chatUpdateStatus.setText(message);
            chatUpdateStatus.setVisibility(available ? View.VISIBLE : View.GONE);
        }
        if (chatUpdateButton != null) {
            chatUpdateButton.setVisibility(available ? View.VISIBLE : View.GONE);
            chatUpdateButton.setEnabled(!updateBusy);
            chatUpdateButton.setText(updateBusy ? "下载中" : "下载更新");
        }
        if (authSubmitButton != null) {
            authSubmitButton.setEnabled(!required && !updateBusy && authProgress.getVisibility() != View.VISIBLE);
        }
        if (sendButton != null) {
            sendButton.setEnabled(!required && !updateBusy);
        }
    }

    private void downloadAndInstallUpdate() {
        if (updateStatus == null || updateBusy) {
            return;
        }
        final String apkUrl = updateStatus.optString("apkUrl", "").trim();
        if (apkUrl.isEmpty()) {
            setUpdateMessage("服务端没有提供 Android APK 下载地址。");
            return;
        }
        updateBusy = true;
        renderUpdateStatus();
        setUpdateMessage("正在下载新版客户端。");
        runAsync(new Task() {
            @Override
            public void run() throws Exception {
                final File apkFile = downloadApk(apkUrl);
                runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        updateBusy = false;
                        renderUpdateStatus();
                        installApk(apkFile);
                    }
                });
            }
        }, new ErrorHandler() {
            @Override
            public void onError(Exception error) {
                updateBusy = false;
                renderUpdateStatus();
                setUpdateMessage(messageOf(error));
            }
        });
    }

    private void setUpdateMessage(final String message) {
        runOnMain(new Runnable() {
            @Override
            public void run() {
                if (authUpdateStatus != null && authUpdateStatus.getVisibility() == View.VISIBLE) {
                    authUpdateStatus.setText(message);
                }
                if (chatUpdateStatus != null && chatUpdateStatus.getVisibility() == View.VISIBLE) {
                    chatUpdateStatus.setText(message);
                }
                if (authStatus != null && (authUpdateStatus == null || authUpdateStatus.getVisibility() != View.VISIBLE)) {
                    authStatus.setText(message);
                }
                if (chatStatus != null && (chatUpdateStatus == null || chatUpdateStatus.getVisibility() != View.VISIBLE)) {
                    chatStatus.setText(message);
                }
            }
        });
    }

    private File downloadApk(String apkUrl) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(apkUrl).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(120000);
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
        int status = connection.getResponseCode();
        if (status >= 400) {
            String responseText = readResponse(connection.getErrorStream());
            connection.disconnect();
            throw new ApiException(responseText == null || responseText.trim().isEmpty() ? "下载更新失败。" : responseText);
        }
        File updateDir = new File(getCacheDir(), "updates");
        if (!updateDir.exists()) {
            updateDir.mkdirs();
        }
        File apkFile = new File(updateDir, "baize-update.apk");
        final int totalBytes = connection.getContentLength();
        InputStream input = connection.getInputStream();
        FileOutputStream output = new FileOutputStream(apkFile);
        byte[] buffer = new byte[8192];
        int bytesRead;
        int downloadedBytes = 0;
        int lastPercent = -1;
        while ((bytesRead = input.read(buffer)) != -1) {
            output.write(buffer, 0, bytesRead);
            downloadedBytes += bytesRead;
            if (totalBytes > 0) {
                int percent = Math.min(100, downloadedBytes * 100 / totalBytes);
                if (percent != lastPercent) {
                    lastPercent = percent;
                    setUpdateMessage("正在下载新版客户端 " + percent + "%");
                }
            } else {
                setUpdateMessage("正在下载新版客户端 " + downloadedBytes / 1024 + "KB");
            }
        }
        output.close();
        input.close();
        connection.disconnect();
        return apkFile;
    }

    private void installApk(File apkFile) {
        if (apkFile == null || !apkFile.exists()) {
            setUpdateMessage("新版 APK 下载失败，请重试。");
            return;
        }
        if (!getPackageManager().canRequestPackageInstalls()) {
            pendingUpdateApk = apkFile;
            setUpdateMessage("请先允许白泽安装未知应用，返回后会继续安装。");
            Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()));
            startActivity(settingsIntent);
            return;
        }
        Uri apkUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
    }

    private void applyUser(JSONObject user, String fallbackUsername) {
        if (user == null) {
            username = fallbackUsername;
            accountJiraDefaultProjectKey = null;
            accountJiraUsername = null;
            return;
        }
        username = user.optString("username", fallbackUsername);
        JSONObject jiraDefaults = user.optJSONObject("jiraDefaults");
        accountJiraDefaultProjectKey = readOptionalString(jiraDefaults, "defaultProjectKey");
        accountJiraUsername = readOptionalString(jiraDefaults, "username");
    }

    private String readOptionalString(JSONObject source, String key) {
        if (source == null || source.isNull(key)) {
            return null;
        }
        String value = source.optString(key, null);
        return value == null || value.trim().isEmpty() ? null : value.trim();
    }

    private void renderSettingsPanel() {
        if (settingsPanel != null) {
            settingsPanel.setVisibility(settingsExpanded ? View.VISIBLE : View.GONE);
        }
        if (settingsToggleButton != null) {
            settingsToggleButton.setText(settingsExpanded ? "收起设置" : "设置");
        }
        if (accountText != null) {
            accountText.setText(username == null ? "账号：已登录" : "账号：" + username);
        }
    }

    private void renderAccountJiraDefaults() {
        if (accountJiraDefaultProjectInput != null) {
            accountJiraDefaultProjectInput.setText(accountJiraDefaultProjectKey == null ? "" : accountJiraDefaultProjectKey);
        }
        if (accountJiraUsernameInput != null) {
            accountJiraUsernameInput.setText(accountJiraUsername == null ? "" : accountJiraUsername);
        }
    }

    private void saveAccountJiraDefaults() {
        final String defaultProjectKey = accountJiraDefaultProjectInput.getText().toString().trim();
        final String jiraUsername = accountJiraUsernameInput.getText().toString().trim();
        saveAccountJiraDefaultsButton.setEnabled(false);
        chatStatus.setText("正在保存账号 Jira 默认配置。");
        runAsync(new Task() {
            @Override
            public void run() throws Exception {
                JSONObject body = new JSONObject();
                body.put("defaultProjectKey", defaultProjectKey);
                body.put("username", jiraUsername);
                JSONObject data = request("PATCH", "/auth/me/jira-defaults", body, token);
                applyUser(data.optJSONObject("user"), username);
                runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        renderAccountJiraDefaults();
                        saveAccountJiraDefaultsButton.setEnabled(true);
                        settingsExpanded = false;
                        renderSettingsPanel();
                        chatStatus.setText("账号 Jira 默认配置已保存。");
                    }
                });
            }
        }, new ErrorHandler() {
            @Override
            public void onError(Exception error) {
                saveAccountJiraDefaultsButton.setEnabled(true);
                chatStatus.setText(messageOf(error));
            }
        });
    }

    private void sendChat() {
        if (isUpdateRequired()) {
            chatStatus.setText("当前版本必须更新后才能继续使用。");
            return;
        }
        final String text = chatInput.getText().toString().trim();
        if (text.isEmpty()) {
            return;
        }
        chatInput.setText("");
        addMessage("我", text);
        setChatLoading(true);
        runAsync(new Task() {
            @Override
            public void run() throws Exception {
                JSONObject body = new JSONObject();
                body.put("text", text);
                body.put("platform", "android");
                body.put("clientId", clientId);
                if (conversationId != null) {
                    body.put("conversationId", conversationId);
                }
                try {
                    sendChatStream(body);
                } catch (Exception streamError) {
                    updateChatStatus("流式连接中断，正在切换普通请求。");
                    sendChatFallback(body);
                }
            }
        }, new ErrorHandler() {
            @Override
            public void onError(Exception error) {
                setChatLoading(false);
                addMessage("白泽", messageOf(error));
            }
        });
    }

    private void sendChatFallback(JSONObject body) throws Exception {
        JSONObject data = request("POST", "/chat", body, token);
        final String reply = data.optString("reply", "白泽没有返回内容。");
        JSONObject conversation = data.optJSONObject("conversation");
        if (conversation != null) {
            conversationId = conversation.optString("id", conversationId);
        }
        runOnMain(new Runnable() {
            @Override
            public void run() {
                addMessage("白泽", reply);
                setChatLoading(false);
            }
        });
    }

    private void sendChatStream(JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(cleanServerUrl(serverUrl) + "/chat/stream").openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(120000);
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        if (token != null && !token.trim().isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Length", String.valueOf(payload.length));
        OutputStream output = connection.getOutputStream();
        output.write(payload);
        output.close();

        int status = connection.getResponseCode();
        if (status >= 400) {
            String responseText = readResponse(connection.getErrorStream());
            connection.disconnect();
            throw new ApiException(responseText == null || responseText.trim().isEmpty() ? "请求失败。" : responseText);
        }

        BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
        StringBuilder eventBuilder = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.trim().isEmpty()) {
                consumeChatStreamEvent(eventBuilder.toString());
                eventBuilder.setLength(0);
            } else {
                eventBuilder.append(line).append('\n');
            }
        }
        if (eventBuilder.length() > 0) {
            consumeChatStreamEvent(eventBuilder.toString());
        }
        reader.close();
        connection.disconnect();
    }

    private void consumeChatStreamEvent(String chunk) throws Exception {
        if (chunk == null || chunk.trim().isEmpty()) {
            return;
        }
        String[] lines = chunk.split("\\r?\\n");
        String data = null;
        for (String line : lines) {
            if (line.startsWith("data:")) {
                data = line.substring(5).trim();
                break;
            }
        }
        if (data == null || data.isEmpty()) {
            return;
        }
        JSONObject event = new JSONObject(data);
        handleChatStreamEvent(event);
    }

    private void handleChatStreamEvent(final JSONObject event) throws Exception {
        final String type = event.optString("type", "");
        if ("activity".equals(type)) {
            updateChatStatus(event.optString("message", "正在处理。"));
            return;
        }
        if ("heartbeat".equals(type)) {
            return;
        }
        if ("error".equals(type)) {
            throw new ApiException(event.optString("message", "白泽流式回复失败。"));
        }
        if ("done".equals(type)) {
            final String reply = event.optString("reply", "白泽没有返回内容。");
            JSONObject conversation = event.optJSONObject("conversation");
            if (conversation != null) {
                conversationId = conversation.optString("id", conversationId);
            }
            runOnMain(new Runnable() {
                @Override
                public void run() {
                    addMessage("白泽", reply);
                    setChatLoading(false);
                }
            });
        }
    }

    private void updateChatStatus(final String message) {
        runOnMain(new Runnable() {
            @Override
            public void run() {
                chatStatus.setText(message);
            }
        });
    }

    private void logout() {
        setChatLoading(true);
        runAsync(new Task() {
            @Override
            public void run() throws Exception {
                request("POST", "/auth/logout", new JSONObject(), token);
                clearSession();
                runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        conversationId = null;
                        messagesLayout.removeAllViews();
                        showAuthScreen("已退出登录。", false);
                    }
                });
            }
        }, new ErrorHandler() {
            @Override
            public void onError(Exception error) {
                clearSession();
                conversationId = null;
                showAuthScreen("已退出登录。", false);
            }
        });
    }

    private void setChatLoading(boolean loading) {
        sendButton.setEnabled(!loading && !isUpdateRequired() && !updateBusy);
        if (saveAccountJiraDefaultsButton != null) {
            saveAccountJiraDefaultsButton.setEnabled(!loading && !updateBusy);
        }
        chatStatus.setText(loading ? "正在请求白泽。" : "");
    }

    private void addMessage(String author, String text) {
        boolean mine = "我".equals(author);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setGravity(mine ? Gravity.RIGHT : Gravity.LEFT);

        TextView name = new TextView(this);
        name.setText(author);
        name.setTextColor(MUTED);
        name.setTextSize(11);
        name.setPadding(dp(4), 0, dp(4), dp(3));
        row.addView(name, wrapWrap());

        TextView bubble = new TextView(this);
        bubble.setText(text);
        bubble.setTextColor(TEXT);
        bubble.setTextSize(15);
        bubble.setLineSpacing(dp(2), 1.0f);
        bubble.setPadding(dp(12), dp(9), dp(12), dp(9));
        bubble.setBackground(roundRect(mine ? BUBBLE_ME : BUBBLE_BAIZE, dp(5)));
        row.addView(bubble, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout.LayoutParams params = matchWrap(dp(10));
        messagesLayout.addView(row, params);
        messagesScroll.post(new Runnable() {
            @Override
            public void run() {
                messagesScroll.fullScroll(View.FOCUS_DOWN);
            }
        });
    }

    private JSONObject request(String method, String path, JSONObject body, String requestToken) throws Exception {
        String address = cleanServerUrl(serverUrl) + path;
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("Accept", "application/json");
        if (requestToken != null && !requestToken.trim().isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + requestToken);
        }
        if (body != null) {
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Content-Length", String.valueOf(payload.length));
            OutputStream output = connection.getOutputStream();
            output.write(payload);
            output.close();
        }

        int status = connection.getResponseCode();
        String responseText = readResponse(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        connection.disconnect();
        JSONObject response;
        try {
            response = responseText == null || responseText.trim().isEmpty() ? new JSONObject() : new JSONObject(responseText);
        } catch (JSONException error) {
            throw new ApiException("白泽服务器返回了非 JSON 响应：HTTP " + status + "。请确认服务器已重启到最新版本。");
        }
        if (status >= 400 || !response.optBoolean("ok", false)) {
            JSONObject error = response.optJSONObject("error");
            String message = error == null ? "请求失败。" : error.optString("message", "请求失败。");
            throw new ApiException(message);
        }
        JSONObject data = response.optJSONObject("data");
        return data == null ? new JSONObject() : data;
    }

    private String readResponse(InputStream input) throws Exception {
        if (input == null) {
            return "";
        }
        BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
        StringBuilder builder = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            builder.append(line);
        }
        reader.close();
        return builder.toString();
    }

    private String cleanServerUrl(String value) {
        String cleaned = value == null ? "" : value.trim();
        while (cleaned.endsWith("/")) {
            cleaned = cleaned.substring(0, cleaned.length() - 1);
        }
        return cleaned;
    }

    private void saveSession() {
        getPreferences(MODE_PRIVATE).edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_USERNAME, username)
            .apply();
    }

    private void clearSession() {
        token = null;
        username = null;
        getPreferences(MODE_PRIVATE).edit()
            .remove(KEY_TOKEN)
            .remove(KEY_USERNAME)
            .apply();
    }

    private EditText createInput(String hint, int inputType) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextColor(TEXT);
        input.setHintTextColor(0xFF98A2B3);
        input.setTextSize(15);
        input.setInputType(inputType);
        input.setFocusable(true);
        input.setFocusableInTouchMode(true);
        input.setPadding(dp(12), dp(8), dp(12), dp(8));
        input.setBackground(roundRect(0xFFFFFFFF, dp(4)));
        return input;
    }

    private GradientDrawable roundRect(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        return drawable;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams matchWrap(int bottomMargin) {
        LinearLayout.LayoutParams params = matchWrap();
        params.setMargins(0, 0, 0, bottomMargin);
        return params;
    }

    private LinearLayout.LayoutParams wrapWrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams wrapCenter(int topMargin) {
        LinearLayout.LayoutParams params = wrapWrap();
        params.gravity = Gravity.CENTER_HORIZONTAL;
        params.setMargins(0, topMargin, 0, 0);
        return params;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void runAsync(final Task task, final ErrorHandler errorHandler) {
        executor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    task.run();
                } catch (final Exception error) {
                    runOnMain(new Runnable() {
                        @Override
                        public void run() {
                            errorHandler.onError(error);
                        }
                    });
                }
            }
        });
    }

    private void runOnMain(Runnable runnable) {
        mainHandler.post(runnable);
    }

    private String messageOf(Exception error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty() ? "请求失败，请检查服务器地址和网络。" : message;
    }

    private interface Task {
        void run() throws Exception;
    }

    private interface ErrorHandler {
        void onError(Exception error);
    }

    private static class ApiException extends Exception {
        ApiException(String message) {
            super(message);
        }
    }
}
